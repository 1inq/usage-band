import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { EngineInterface } from 'claude-code'

import type { Cache, Info, Usage } from '../types'

// ponytail: fixed 1h TTL (Claude Code's prompt cache on subscriptions); 5 min on plain API keys
const CACHE_TTL = 60 * 60_000
const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; short: string; ms: number; ticks: number }> = {
  five_hour: { label: 'Session', short: '5h', ms: 5 * HOUR, ticks: 5 },
  seven_day: { label: 'Week', short: 'Wk', ms: 7 * 24 * HOUR, ticks: 7 },
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TRACK = 'rgba(128,128,128,0.35)'
const TICK = 'rgba(128,128,128,0.9)'
const MARKER = '#3b82f6'
const MODEL_C = '#6ea8fe'
const BRANCH_C = '#c792ea'
const ADD_C = '#7ee787'
const DEL_C = '#ff8c8c'

const ZERO: Cache = { read: 0, write: 0, input: 0, output: 0, lastRead: 0, lastIn: 0, lastAt: 0 }
const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, ZERO)
const info = atom({ plugin: 'usage-band', key: 'info' } as const, null as Info | null)
const isCompact = atom({ plugin: 'usage-band', key: 'isCompact' } as const, false)

const pick = (u: Usage): Usage => ({
  startedAt: u.startedAt,
  context: { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent },
  rateLimits: u.rateLimits.map(r => ({ ...r })),
  cost: u.cost && { usd: u.cost.usd },
})

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const level = (pct: number) => (pct >= 90 ? '#e5484d' : pct >= 70 ? '#e0a100' : '#30a46c')
const pad = (n: number) => String(n).padStart(2, '0')
const left = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h${pad(m % 60)}` : `${m} min`
}
const at = (iso: string, withDay: boolean) => {
  const t = new Date(iso)
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  return withDay ? `${WEEKDAYS[t.getDay()]} ${hm}` : hm
}

// SVG bar: track, fill, tick separators, optional "elapsed time" marker.
// stretch: the bar fills its slot; ticks/marker keep 1.5/2px via non-scaling strokes
const svgBar = (pct: number, ticks: number, marker?: number, W = 520, H = 8, stretch = false) => {
  const p = Math.max(0, Math.min(1, pct / 100))
  const line = (x: number, color: string, w: number, op = 1) =>
    `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${color}" stroke-width="${w}" opacity="${op}" vector-effect="non-scaling-stroke"/>`
  const lines = Array.from({ length: Math.max(0, ticks - 1) }, (_, i) => line(((i + 1) * W) / ticks, TICK, 1.5)).join('')
  const m = marker === undefined ? '' : line(Math.min(W - 1, Math.max(1, marker * W)), MARKER, 2)
  const fit = stretch ? ' preserveAspectRatio="none"' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${fit}>
<clipPath id="c"><rect width="${W}" height="${H}" rx="${stretch ? 0 : H / 2}"/></clipPath>
<g clip-path="url(#c)"><rect width="${W}" height="${H}" fill="${TRACK}"/><rect width="${W * p}" height="${H}" fill="${level(pct)}"/>${lines}${m}</g></svg>`
}
// Terminal bar as runs of [text, kind]: fill, track, and a marker cell (elapsed time)
type Run = [string, 'fill' | 'track' | 'marker']
const barRuns = (pct: number, w: number, marker?: number): Run[] => {
  const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  const at = marker === undefined ? -1 : Math.max(0, Math.min(w - 1, Math.floor(marker * w)))
  const runs: Run[] = []
  for (let i = 0; i < w; i++) {
    const kind = i === at ? 'marker' : i < filled ? 'fill' : 'track'
    const ch = kind === 'marker' ? '┃' : kind === 'fill' ? '█' : '░'
    const last = runs[runs.length - 1]
    if (last && last[1] === kind) last[0] += ch
    else runs.push([ch, kind])
  }
  return runs
}

// model + git branch + changed lines vs HEAD (outside a repo: branch undefined)
const sumNumstat = (out: string) => {
  let added = 0
  let removed = 0
  for (const line of out.split('\n')) {
    const [a, d] = line.split('\t')
    added += Number(a) || 0 // binary files read "-": counted 0
    removed += Number(d) || 0
  }
  return { added, removed }
}

const refreshInfo = async ($: EngineInterface) => {
  const model = await $.session.model()
  let branch: string | undefined
  let added = 0
  let removed = 0
  let files = 0
  try {
    const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 5000 })
    const b = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (b.exitCode === 0) {
      branch = b.stdout.trim()
      // staged + unstaged against HEAD; a repo with no commit yet has no HEAD, so add the two diffs
      const d = await run(['git', 'diff', 'HEAD', '--numstat'])
      if (d.exitCode === 0) {
        ;({ added, removed } = sumNumstat(d.stdout))
      } else {
        const staged = sumNumstat((await run(['git', 'diff', '--cached', '--numstat'])).stdout)
        const loose = sumNumstat((await run(['git', 'diff', '--numstat'])).stdout)
        added = staged.added + loose.added
        removed = staged.removed + loose.removed
      }
      // files, untracked included, so a tree with only new files is not "clean"
      files = (await run(['git', 'status', '--porcelain'])).stdout.split('\n').filter(Boolean).length
    }
  } catch {
    // git missing or timed out: show the model alone
  }
  await update($, info, () => ({ model, branch, added, removed, files }))
}

type Cell = { label: string; short: string; pct: number; info: string; ticks: number; marker?: number }

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    void $.session.usage().then(u => update($, usage, () => pick(u)))
    // redraw once a minute so countdowns move between turns
    timer?.cancel()
    void refreshInfo($)
    timer = $.clock.every(60_000, () => {
      $.ui.invalidate('ui.render')
      void refreshInfo($)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const u = await $.session.usage()
    await update($, usage, () => pick(u))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const t = e.usage
    if (t) {
      const now = await $.clock.now()
      await update($, cache, c => ({
        read: c.read + t.cache_read_input_tokens,
        write: c.write + t.cache_creation_input_tokens,
        input: c.input + t.input_tokens,
        output: c.output + t.output_tokens,
        lastRead: t.cache_read_input_tokens,
        lastIn: t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens,
        lastAt: now,
      }))
    }
    void refreshInfo($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u) return next(e)

    const c = await read($, cache)
    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // the terminal's table lists Svg but draws it empty, so go by the surface, not the table
    const isTerm = e.surface === 'terminal'
    const cols = e.props.bodyColumns
    const bar = (x: Cell, w: number) => (
      <Text>
        {barRuns(x.pct, Math.max(3, w), x.marker).map(([t, kind]) =>
          kind === 'track' ? <Text dimColor>{t}</Text> : <Text color={kind === 'marker' ? MARKER : level(x.pct)}>{t}</Text>,
        )}
      </Text>
    )
    const compact = await read($, isCompact)
    const meta = await read($, info)

    const ctxPct = u.context.percent ?? 0
    const hit = c.lastIn ? Math.round((c.lastRead / c.lastIn) * 100) : 0
    const ttlLeft = c.lastAt ? CACHE_TTL - (now - c.lastAt) : 0

    const cells: Cell[] = [
      {
        label: 'Context',
        short: 'Ctx',
        pct: ctxPct,
        info: `${k(u.context.tokens ?? 0)} / ${k(u.context.window)}`,
        ticks: 10,
      },
      {
        label: 'Cache',
        short: 'Cache',
        pct: hit,
        info: !c.lastAt ? '—' : ttlLeft > 0 ? `warm · ${left(ttlLeft)}` : 'cold',
        ticks: 0,
      },
    ]
    for (const [kind, w] of Object.entries(WINDOWS)) {
      const r = u.rateLimits.find(x => x.kind === kind)
      if (!r) {
        cells.push({ label: w.label, short: w.short, pct: 0, info: 'no data', ticks: w.ticks })
        continue
      }
      const rest = r.resetsAt ? Date.parse(r.resetsAt) - now : undefined
      cells.push({
        label: w.label,
        short: w.short,
        pct: r.percentUsed,
        info: r.resetsAt && rest !== undefined ? `↻ ${left(rest)} · ${at(r.resetsAt, kind !== 'five_hour')}` : '',
        ticks: w.ticks,
        marker: rest === undefined ? undefined : 1 - rest / w.ms,
      })
    }

    // terminal: cells get fixed widths from the band's columns so the bars fill the row
    const BTN = 6
    const wideW = Math.floor((cols - BTN - 3) / 2)
    const cell = (x: Cell) => (
      <Box flexDirection="column" flexGrow={1} width={isTerm ? wideW : undefined}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text weight="semibold">{x.label}</Text> <Text color={level(x.pct)}>{Math.round(x.pct)}%</Text>
          </Text>
          <Text dimColor>{x.info}</Text>
        </Box>
        {!isTerm && 'Svg' in ui ? (
          <ui.Svg source={svgBar(x.pct, x.ticks, x.marker)} alt={`${x.label} ${Math.round(x.pct)}%`} />
        ) : (
          bar(x, wideW)
        )}
      </Box>
    )

    // compact: one row of 4 small bars, label and percent beside each
    // info line as [text, color] parts (no color = dim), so length and drawing share one source
    type Part = [string, string | undefined]
    const infoParts = (sep: string): Part[] => {
      if (!meta) return []
      const parts: Part[] = [[meta.model, MODEL_C]]
      if (meta.branch === undefined) return [...parts, [`${sep}no git`, undefined]]
      parts.push([sep, undefined], [`⎇ ${meta.branch}`, BRANCH_C], [sep, undefined])
      if (meta.added || meta.removed) parts.push([`+${meta.added}`, ADD_C], [' ', undefined], [`-${meta.removed}`, DEL_C])
      else parts.push([meta.files ? `${meta.files} untracked` : 'clean', undefined])
      return parts
    }
    const infoText = (parts: Part[]) => (
      <Text size="caption">
        {parts.map(([t, c]) => (c ? <Text color={c}>{t}</Text> : <Text dimColor>{t}</Text>))}
      </Text>
    )
    const wide = infoParts('  ·  ')
    const short = infoParts(' ')
    const metaLen = short.reduce((n, [t]) => n + t.length, 0)

    const gaps = 2 * 4
    const smallW = Math.floor((cols - BTN - gaps - metaLen - 1) / 4)
    const small = (x: Cell) => (
      <Box flexDirection="row" alignItems="center" gap="xs" flexGrow={1} flexShrink={1} minWidth={0} width={isTerm ? smallW : undefined}>
        <Box flexShrink={0}>
          <Text size="caption">
            <Text weight="semibold">{x.short}</Text> <Text color={level(x.pct)}>{Math.round(x.pct)}%</Text>
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {!isTerm && 'Svg' in ui ? (
            <ui.Svg source={svgBar(x.pct, x.ticks, x.marker, 1000, 5, true)} height={5} alt={`${x.label} ${Math.round(x.pct)}%`} />
          ) : (
            bar(x, smallW - `${x.short} ${Math.round(x.pct)}%`.length - 1)
          )}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="row" alignItems="flex-end" justifyContent="space-between" gap="sm" width="100%">
        {compact ? (
          <Box flexDirection="row" alignItems="center" gap="md" flexGrow={1} minWidth={0}>
            <Box flexShrink={0}>
              {infoText(short)}
            </Box>
            {cells.map(small)}
          </Box>
        ) : (
          <Box flexDirection="column" gap="sm" flexGrow={1}>
            {[cells.slice(0, 2), cells.slice(2)].map(row => (
              <Box flexDirection="row" gap="lg">{row.map(cell)}</Box>
            ))}
            {meta && infoText(wide)}
          </Box>
        )}
        <Button
          key="toggle"
          label={compact ? '▴' : '▾'}
          onPress={() => update($, isCompact, v => !v)}
        />
      </Box>
    )
  })
}
