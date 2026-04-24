import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { PartTable, SessionTable } from "@/session/session.sql"
import type { MessageV2 } from "@/session/message-v2"
import { Database, eq } from "@/storage/db"
import { zod } from "@/util/effect-zod"
import { Log } from "@/util"
import { withStatics } from "@/util/schema"
import { Instance } from "@/project/instance"
import { QuestionID } from "./schema"

const log = Log.create({ service: "question" })

// Schemas

export class Option extends Schema.Class<Option>("QuestionOption")({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}) {
  static readonly zod = zod(this)
}

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export class Info extends Schema.Class<Info>("QuestionInfo")({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({
    description: "Allow typing a custom answer (default: true)",
  }),
}) {
  static readonly zod = zod(this)
}

export class Prompt extends Schema.Class<Prompt>("QuestionPrompt")(base) {
  static readonly zod = zod(this)
}

export class Tool extends Schema.Class<Tool>("QuestionTool")({
  messageID: MessageID,
  callID: Schema.String,
}) {
  static readonly zod = zod(this)
}

export class Request extends Schema.Class<Request>("QuestionRequest")({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}) {
  static readonly zod = zod(this)
}

export const Answer = Schema.Array(Schema.String)
  .annotate({ identifier: "QuestionAnswer" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Answer = Schema.Schema.Type<typeof Answer>

export class Reply extends Schema.Class<Reply>("QuestionReply")({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}) {
  static readonly zod = zod(this)
}

interface PendingEntry {
  info: Request
  deferred?: Deferred.Deferred<Answer[], RejectedError>
  part?: PartID
}

class Replied extends Schema.Class<Replied>("QuestionReplied")({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}) {}

class Rejected extends Schema.Class<Rejected>("QuestionRejected")({
  sessionID: SessionID,
  requestID: QuestionID,
}) {}

export const Event = {
  Asked: BusEvent.define("question.asked", Request.zod),
  Replied: BusEvent.define("question.replied", zod(Replied)),
  Rejected: BusEvent.define("question.rejected", zod(Rejected)),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: { requestID: QuestionID; answers: ReadonlyArray<Answer> }) => Effect.Effect<void>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              if (item.deferred) yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    function running(part: MessageV2.Part): part is MessageV2.ToolPart & { state: MessageV2.ToolStateRunning } {
      return part.type === "tool" && part.tool === "question" && part.state.status === "running"
    }

    function update(
      id: PartID,
      build: (part: MessageV2.ToolPart & { state: MessageV2.ToolStateRunning }) =>
        | MessageV2.ToolStateCompleted
        | MessageV2.ToolStateError,
    ) {
      const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())
      if (!row || !running(row.data as MessageV2.Part)) return
      const part = row.data as MessageV2.ToolPart & { state: MessageV2.ToolStateRunning }
      Database.use((db) =>
        db
          .update(PartTable)
          .set({ data: { ...part, state: build(part) } as typeof PartTable.$inferInsert.data, time_updated: Date.now() })
          .where(eq(PartTable.id, id))
          .run(),
      )
    }

    const recover = Effect.fn("Question.recover")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      const rows = Database.use((db) =>
        db
          .select({ part: PartTable })
          .from(PartTable)
          .innerJoin(SessionTable, eq(PartTable.session_id, SessionTable.id))
          .where(eq(SessionTable.directory, Instance.directory))
          .orderBy(PartTable.id)
          .all(),
      )

      const seen = new Set(
        [...pending.values()]
          .map((item) => item.info.tool)
          .filter((tool): tool is NonNullable<Request["tool"]> => !!tool)
          .map((tool) => `${tool.messageID}:${tool.callID}`),
      )

      for (const row of rows) {
        const data = row.part.data as MessageV2.Part
        if (!running(data)) continue
        const key = `${row.part.message_id}:${data.callID}`
        if (seen.has(key)) continue
        seen.add(key)

        const id = QuestionID.ascending()
        pending.set(id, {
          info: {
            id,
            sessionID: row.part.session_id,
            questions: data.state.input.questions as Info[],
            tool: { messageID: row.part.message_id, callID: data.callID },
          },
          part: row.part.id,
        })
      }
    })

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      log.info("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      })
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        log.warn("reply for unknown request", { requestID: input.requestID })
        return
      }
      pending.delete(input.requestID)
      log.info("replied", { requestID: input.requestID, answers: input.answers })
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers,
      })

      if (existing.part) {
        update(existing.part, (part) => ({
          status: "completed",
          input: part.state.input,
          output: `User answered: ${input.answers.map((x) => x.join(", ")).join(" | ")}`,
          title: `Asked ${part.state.input.questions.length} question${part.state.input.questions.length === 1 ? "" : "s"}`,
          metadata: { answers: input.answers },
          time: { start: part.state.time.start, end: Date.now() },
        }))
      }

      if (existing.deferred) yield* Deferred.succeed(existing.deferred, input.answers)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        log.warn("reject for unknown request", { requestID })
        return
      }
      pending.delete(requestID)
      log.info("rejected", { requestID })
      yield* bus.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })

      if (existing.part) {
        update(existing.part, (part) => ({
          status: "error",
          input: part.state.input,
          error: "The user dismissed this question",
          time: { start: part.state.time.start, end: Date.now() },
        }))
      }

      if (existing.deferred) yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const list = Effect.fn("Question.list")(function* () {
      yield* recover()
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function ask(input: {
  sessionID: SessionID
  questions: Info[]
  tool?: { messageID: MessageID; callID: string }
}): Promise<Answer[]> {
  return runPromise((s) => s.ask(input))
}

export async function reply(input: { requestID: QuestionID; answers: Answer[] }) {
  return runPromise((s) => s.reply(input))
}

export async function reject(requestID: QuestionID) {
  return runPromise((s) => s.reject(requestID))
}

export async function list() {
  return runPromise((s) => s.list())
}

export * as Question from "."
