// The agent result contract, in three forms that must stay in sync:
//   1. AGENT_RESULT_SCHEMA — handed to the CLI's own structured-output
//      validator (codex --output-schema / claude --json-schema), so bad shapes
//      fail inside the agent turn;
//   2. validateAgentResult (collaboration-result.js) — the authoritative
//      server-side re-check; the CLI-side constraint is convenience, not trust;
//   3. RESULT_CONTRACT_PROMPT — the plain-text rules appended to every prompt.
// Recipient enums are rebuilt per turn from the CURRENT run membership.

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });

export function buildResultSchema({ recipientIds, messagesPerTurn = 8 }) {
  if (!Array.isArray(recipientIds)) {
    throw new Error('buildResultSchema requires the current run participants (possibly empty for solo runs)');
  }
  // An empty enum matches nothing: a solo agent structurally cannot invent
  // recipients. validateAgentResult re-checks server-side regardless.
  const recipients = { type: 'string', enum: [...recipientIds] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'outcome', 'artifacts', 'checks', 'messages', 'followUps', 'question'],
    properties: {
      summary: text(16000),
      outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
      artifacts: {
        type: 'array', maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['path', 'description'],
          properties: { path: text(4096), description: text(4000) },
        },
      },
      checks: {
        type: 'array', maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'status', 'evidence'],
          properties: { name: text(240), status: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, evidence: text(8000) },
        },
      },
      messages: {
        type: 'array', maxItems: messagesPerTurn,
        items: {
          type: 'object', additionalProperties: false, required: ['to', 'text'],
          properties: { to: recipients, text: text(16000) },
        },
      },
      followUps: {
        type: 'array', maxItems: 8,
        items: {
          type: 'object', additionalProperties: false, required: ['assignee', 'instruction', 'dependencies'],
          properties: { assignee: recipients, instruction: text(16000), dependencies: { type: 'array', maxItems: 32, items: text(96) } },
        },
      },
      question: { type: ['string', 'null'], maxLength: 4000 },
    },
    // A blocked result must carry a concrete question for the operator.
    if: { properties: { outcome: { const: 'blocked' } } },
    then: { properties: { question: { type: 'string', minLength: 1 } } },
  };
}

export const RESULT_CONTRACT_PROMPT = [
  'You are one managed agent inside a clihive collaboration run.',
  'Work only on your assigned task, inside your approved working directory and permission profile.',
  'Your FINAL message must be exactly one JSON object and nothing else, matching this contract:',
  '  summary: string — what you did and what changed.',
  '  outcome: "done" | "blocked" | "failed".',
  '  artifacts: [{ path, description }] — files you created or modified (claims, verified later).',
  '  checks: [{ name, status: "passed"|"failed"|"not_run", evidence }] — verifications you ran.',
  '  messages: [{ to, text }] — messages to the listed peer agents only.',
  '  followUps: [{ assignee, instruction, dependencies }] — proposed next tasks; the scheduler decides.',
  '  question: string | null — required (non-null) when outcome is "blocked".',
  'Rules: never invent recipients; "done" does not self-approve — an independent review gate follows;',
  'do not claim side effects you cannot evidence; if you need permission you do not have, stop and report "blocked" with a question.',
].join('\n');
