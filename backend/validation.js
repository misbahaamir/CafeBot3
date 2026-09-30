const { z } = require('zod');
const { USERNAME_PATTERN } = require('./staff');

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

module.exports = { loginBodySchema, validate };
