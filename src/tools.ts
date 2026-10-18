import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Static introductory facts. Role-gated file resources are registered separately. */

interface MarsFact {
  summary: string;
  detail: string;
}

const FACTS: Record<string, MarsFact> = {
  about: {
    summary: 'What Mars College is',
    detail:
      'Mars College is an off-grid, low-cost experimental community in the ' +
      'California desert, running an annual winter season focused on ' +
      'self-reliance, art, and technology.',
  },
  season: {
    summary: 'Season timing',
    detail:
      'The camp runs a winter season, roughly January through April, in the ' +
      'Bombay Beach / Slab City area near the Salton Sea.',
  },
};

export function registerMarsTools(server: McpServer): void {
  server.registerTool(
    'mars_lookup',
    {
      title: 'Look up Mars College info',
      description:
        'Look up a fact about Mars College by topic. Returns a short summary and ' +
        'detail. Use list_topics=true to discover available topics.',
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe('Topic key to look up, e.g. "about" or "season".'),
        list_topics: z
          .boolean()
          .optional()
          .describe('If true, return the list of available topics instead of a fact.'),
      },
    },
    async ({ topic, list_topics }) => {
      if (list_topics || !topic) {
        const lines = Object.entries(FACTS).map(([key, f]) => `- ${key}: ${f.summary}`);
        return {
          content: [
            { type: 'text', text: `Available topics:\n${lines.join('\n')}` },
          ],
        };
      }

      // Object.hasOwn, not a bare index: inherited keys such as "constructor",
      // "toString" and "__proto__" are truthy, so a bare lookup skipped the guard
      // below and returned a successful-looking "undefined\n\nundefined".
      const fact = Object.hasOwn(FACTS, topic) ? FACTS[topic] : undefined;
      if (!fact) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Unknown topic "${topic}". Known topics: ${Object.keys(FACTS).join(', ')}.`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: `${fact.summary}\n\n${fact.detail}` }],
      };
    },
  );
}
