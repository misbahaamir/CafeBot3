const { z } = require('zod');
const { USERNAME_PATTERN } = require('./staff');

const MAX_MESSAGE_LENGTH = 2000;
// Matches the frontend's HISTORY_LIMIT; the history is client-supplied, so cap
// it to bound the prompt size a single request can send to the API.
const MAX_HISTORY_MESSAGES = 10;
const MIN_CANCEL_REASON_LENGTH = 10;
const MAX_CANCEL_REASON_LENGTH = 500;

const ORDER_STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

const chatRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    conversationHistory: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
          })
          .strict()
      )
      .max(MAX_HISTORY_MESSAGES)
      .default([]),
    sessionId: z.uuid().optional(),
  })
  .strict();

const orderIdParamsSchema = z.object({ id: z.uuid() });

const orderStatusBodySchema = z.object({ status: z.enum(ORDER_STATUS_FLOW) }).strict();

const cancelOrderBodySchema = z
  .object({ reason: z.string().trim().min(MIN_CANCEL_REASON_LENGTH).max(MAX_CANCEL_REASON_LENGTH) })
  .strict();

const loginBodySchema = z
  .object({
    username: z.string().regex(USERNAME_PATTERN),
    password: z.string().min(1).max(200),
  })
  .strict();

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) {
    return { data: result.data };
  }
  return {
    error: {
      error: 'invalid_request',
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

module.exports = {
  ORDER_STATUS_FLOW,
  chatRequestSchema,
  orderIdParamsSchema,
  orderStatusBodySchema,
  cancelOrderBodySchema,
  loginBodySchema,
  validate,
};
