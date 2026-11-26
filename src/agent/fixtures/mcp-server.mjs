/** A small MCP server over stdio for the agent's tests: `echo` answers its text, `secret` answers an env value. */
import process from 'node:process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Answers the text it is given',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'secret',
      description: 'Answers the value of FIXTURE_VALUE',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text =
    request.params.name === 'echo'
      ? `echo: ${request.params.arguments?.text}`
      : `value: ${process.env.FIXTURE_VALUE ?? ''}`
  return { content: [{ type: 'text', text }] }
})

await server.connect(new StdioServerTransport())
