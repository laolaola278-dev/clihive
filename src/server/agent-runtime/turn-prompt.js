// Build the prompt for one managed turn. Deterministic and side-effect free so
// tests can assert exactly what an agent is told: its identity, the run
// objective, its task, the permission profile it is confined to, the peers it
// may message, and the structured-result contract it must end with.
import { RESULT_CONTRACT_PROMPT } from './result-schema.js';

const PROFILE_TEXT = Object.freeze({
  'read-only': 'READ-ONLY: you may inspect the working directory but cannot modify files or run state-changing commands. If the task needs a write you cannot make, stop and return outcome "blocked" with a question.',
  'workspace-write': 'WORKSPACE-WRITE: you may modify files and run commands inside the approved working directory only. Anything that would prompt for permission is denied automatically; if you are denied, adapt or return outcome "blocked".',
});

function section(title, body) {
  return body ? `## ${title}\n${body}\n` : '';
}

/**
 * @param {object} input
 * @param {{id:string,label:string,provider:string}} input.agent
 * @param {{id:string,objective:string,acceptanceCriteria:string[]}} input.run
 * @param {{id:string,instruction:string,writeScopes?:string[],dependencies?:string[]}} input.task
 * @param {string} input.permissionProfile effective (intersected) profile
 * @param {{id:string,label:string,provider:string}[]} input.peers agents this one may message
 * @param {{id:string,summary:string,verification?:object}[]} [input.dependencyResults]
 * @param {{from:string,text:string}[]} [input.inbox] pending peer/operator messages
 * @returns {string}
 */
export function buildTurnPrompt(input) {
  const { agent, run, task, permissionProfile, peers, dependencyResults = [], inbox = [] } = input;
  const parts = [];

  parts.push(`# Collaboration turn\n`);
  parts.push(`You are **${agent.label}** (agent id \`${agent.id}\`, provider \`${agent.provider}\`), one managed agent in a clihive collaboration run.\n`);

  parts.push(section('Permission profile', PROFILE_TEXT[permissionProfile] ?? PROFILE_TEXT['read-only']));
  parts.push(section('Working directory', `\`${task.cwd ?? run.cwd ?? ''}\``.trim()));

  parts.push(section('Run objective', run.objective));
  if (run.acceptanceCriteria?.length) {
    parts.push(section('Acceptance criteria (the run is done only when all are met)',
      run.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')));
  }

  parts.push(section('Your task', task.instruction));
  if (task.writeScopes?.length) {
    parts.push(section('Write scopes you may touch', task.writeScopes.map((s) => `- \`${s}\``).join('\n')));
  }
  if (dependencyResults.length) {
    parts.push(section('Results from tasks this one depends on',
      dependencyResults.map((d) => `- \`${d.id}\`: ${d.summary}${d.verification?.approved ? ' (reviewed ✓)' : ' (unreviewed)'}`).join('\n')));
  }

  if (inbox.length) {
    parts.push(section('Messages waiting for you', inbox.map((m) => `- from \`${m.from}\`: ${m.text}`).join('\n')));
  }

  if (peers.length) {
    parts.push(section('Peers you may message (use these exact ids in result.messages[].to)',
      peers.map((p) => `- \`${p.id}\` — ${p.label} (${p.provider})`).join('\n')));
  } else {
    parts.push(section('Peers', 'None in this run. Leave result.messages and result.followUps empty.'));
  }

  parts.push(`## How you must finish\n${RESULT_CONTRACT_PROMPT}\n`);
  return parts.filter(Boolean).join('\n');
}
