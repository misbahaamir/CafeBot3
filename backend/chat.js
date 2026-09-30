const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { withDisplayAmounts } = require('./money');
const { maintenanceInputSchema, viewingInputSchema } = require('./requests');

const MODEL = 'claude-sonnet-5-5';
const MAX_MESSAGE_LENGTH = 2000;
// Matches the frontend's HISTORY_LIMIT; the history is client-supplied, so cap
// it to bound the prompt size a single request can send to the API.
const MAX_HISTORY_MESSAGES = 10;
// Bounds the API calls (and cost) one chat message can trigger.
const MAX_TOOL_ROUNDS = 5;

const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'tenant-assistant.md'), 'utf-8');

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
  })
  .strict();

const contactProperties = {
  name: { type: 'string', description: 'Full name of the person making the request.' },
  email: { type: 'string', description: 'Email address for follow-up.' },
  phone: { type: 'string', description: 'Phone number, if the person gave one.' },
};

const TOOLS = [
  {
    name: 'get_listings',
    description: 'Lists the units currently advertised for rent, with asking rent per month and availability date.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_maintenance_request',
    description: 'Files a maintenance request. Only call after the person has confirmed the details you read back.',
    input_schema: {
      type: 'object',
      properties: {
        ...contactProperties,
        address: { type: 'string', description: 'Street address and unit, as the person gave them.' },
        category: {
          type: 'string',
          enum: ['PLUMBING', 'ELECTRICAL', 'HEATING_COOLING', 'APPLIANCE', 'PEST', 'LOCK_OR_DOOR', 'OTHER'],
        },
        urgency: { type: 'string', enum: ['URGENT', 'ROUTINE'] },
        description: { type: 'string', description: 'What is wrong, in the person\'s words (at least 10 characters).' },
      },
      required: ['name', 'email', 'address', 'category', 'urgency', 'description'],
    },
  },
  {
    name: 'submit_viewing_request',
    description:
      'Asks staff to arrange a viewing of a listed unit. Only call after the person has confirmed the details you read back.',
    input_schema: {
      type: 'object',
      properties: {
        ...contactProperties,
        unitId: { type: 'string', description: 'The unitId from get_listings.' },
        preferredTimes: { type: 'string', description: 'Days or times the person prefers.' },
      },
      required: ['name', 'email', 'unitId', 'preferredTimes'],
    },
  },
];

const TOOL_INPUT_SCHEMAS = {
  get_listings: z.object({}).strict(),
  submit_maintenance_request: maintenanceInputSchema,
  submit_viewing_request: viewingInputSchema,
};

const SUBMIT_TOOLS = ['submit_maintenance_request', 'submit_viewing_request'];

function createPublicAssistant({ anthropic, rentalStore, requestStore, loadOffice, today, submitLimiter }) {
  function systemPrompt() {
    return `${BASE_PROMPT}\n# Today's date\n\n${today()}\n\n# Office information\n\n${JSON.stringify(loadOffice(), null, 2)}`;
  }

  // Tool inputs come from the model, which is steered by what the visitor
  // types, so they are validated like any other request input.
  function runTool(name, input, clientKey) {
    const schema = TOOL_INPUT_SCHEMAS[name];
    if (!schema) {
      return { error: 'unknown_tool' };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return {
        error: 'invalid_input',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      };
    }
    if (SUBMIT_TOOLS.includes(name) && !submitLimiter.take(clientKey).allowed) {
      return { error: 'too_many_requests' };
    }
    switch (name) {
      case 'get_listings':
        return { listings: rentalStore.listings() };
      case 'submit_maintenance_request': {
        const request = requestStore.createMaintenance(parsed.data);
        return { referenceNumber: request.id, status: request.status };
      }
      case 'submit_viewing_request': {
        const request = requestStore.createViewing(parsed.data);
        return request.error ? request : { referenceNumber: request.id, status: request.status };
      }
    }
  }

  async function reply({ message, conversationHistory }, clientKey) {
    const system = systemPrompt();
    const messages = [...conversationHistory, { role: 'user', content: message }];
    let response = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, system, tools: TOOLS, messages });

    for (let round = 1; response.stop_reason === 'tool_use'; round += 1) {
      if (round > MAX_TOOL_ROUNDS) {
        throw new Error(`Exceeded ${MAX_TOOL_ROUNDS} tool rounds for one message`);
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: response.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(withDisplayAmounts(runTool(block.name, block.input, clientKey))),
          })),
      });
      response = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, system, tools: TOOLS, messages });
    }

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  return { runTool, reply };
}

module.exports = { createPublicAssistant, chatRequestSchema };
