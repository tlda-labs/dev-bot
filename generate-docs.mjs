import fs from 'node:fs'

import { createCommandRegistry, generateCommandMarkdown, generateConfigMarkdown } from '@tlda/bot'

process.env.TLDA_DEV_BOT_NO_START = '1'
const { commands, configSchema } = await import('./dev-bot.mjs')

const file = new URL('./README.md', import.meta.url)
const original = fs.readFileSync(file, 'utf8')
const replace = (source, start, end, content) => source.replace(
  new RegExp(`(${start})[\\s\\S]*?(${end})`),
  `$1\n${content}\n$2`,
)
let generated = replace(
  original,
  '<!-- BEGIN GENERATED COMMANDS -->',
  '<!-- END GENERATED COMMANDS -->',
  generateCommandMarkdown(createCommandRegistry(commands)),
)
generated = replace(
  generated,
  '<!-- BEGIN GENERATED CONFIG -->',
  '<!-- END GENERATED CONFIG -->',
  generateConfigMarkdown(configSchema),
)

if (process.argv.includes('--check')) {
  if (generated !== original) {
    console.error('README generated command/config sections are stale')
    process.exitCode = 1
  }
} else {
  fs.writeFileSync(file, generated)
}
