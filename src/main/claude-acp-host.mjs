/**
 * Runs the Claude Code ACP adapter in an Electron utility process, so the app never has to run itself as
 * Node (its RunAsNode fuse is off). A utility process has no stdin, so the app sends ACP over the parent
 * port and this script hands it to the adapter as its stdin. Its stdout is a pipe, as before.
 * The last argument is the adapter's entry script.
 */
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

const entry = process.argv.at(-1)
const input = new PassThrough()

// A null message is the end of input: the adapter then closes its connection and exits.
process.parentPort.on('message', ({ data }) => {
  if (data === null) input.end()
  else input.write(data)
})

Object.defineProperty(process, 'stdin', { value: input, configurable: true, enumerable: true })

await import(pathToFileURL(entry).href)
