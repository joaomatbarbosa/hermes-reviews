// Reviews — the review-queue skill's PR drafts as a page in Hermes Desktop.
// Reads ~/review-queue through this plugin's backend (dashboard/plugin_api.py): a list (repo / verdict / tier
// filters, search, sort) and a detail with the draft's sections, plus each open PR's live GitHub state.
// Writes only an entry's status (mark merged / dismiss / mark posted / restore), in the skill's own vocabulary.
// Disk plugin: plain ESM, no JSX, styled with theme variables only.

import { Codicon, host, PALETTE_AREA, queryClient, ROUTES_AREA, SIDEBAR_NAV_AREA, useQuery } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'reviews'
const PATH = '/reviews'
// Shipped by this plugin (skills/), so Hermes resolves it as `reviews:review-queue`.
const SKILL = 'reviews:review-queue'

// ── theme helpers ─────────────────────────────────────────────────────────────────────────────

const T = {
  t1: 'var(--ui-text-primary)',
  t2: 'var(--ui-text-secondary)',
  t3: 'var(--ui-text-tertiary)',
  t4: 'var(--ui-text-quaternary)',
  line: 'var(--ui-stroke-secondary)',
  accent: 'var(--ui-accent)'
}
const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

const VERDICT = {
  blocking: { label: 'Blocking', c: 'var(--ui-red)' },
  'has comments': { label: 'Has comments', c: 'var(--ui-yellow)' },
  'looks good': { label: 'Looks good', c: 'var(--ui-green)' }
}
const verdictOf = v => VERDICT[String(v || '').toLowerCase()] || { label: v || '—', c: T.t3 }
const TIER = { sensitive: 'var(--ui-orange)', standard: 'var(--ui-blue)' }
const TIER_RANK = { sensitive: 0, standard: 1 }
const SEVERITY = { blocker: 'var(--ui-red)', blocking: 'var(--ui-red)', major: 'var(--ui-orange)', minor: 'var(--ui-yellow)', suggestion: 'var(--ui-yellow)', nit: 'var(--ui-blue)', question: 'var(--ui-purple)' }
const RISK = { low: 'var(--ui-green)', medium: 'var(--ui-yellow)', high: 'var(--ui-red)' }
const COUNT_ORDER = [['blocker', 'blockers'], ['major', 'majors'], ['minor', 'minors'], ['nit', 'nits']]
const STATUS_LABEL = { pending: 'pending', posted: 'posted', discarded: 'dismissed', merged: 'merged', closed: 'closed', skipped: 'skipped' }
const SORTS = { tier: 'Tier, newest', newest: 'Newest', oldest: 'Oldest', priority: 'Priority' }

function Pill({ color, children, solid, title }) {
  return h(
    'span',
    {
      title,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 17,
        padding: '0 6px',
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '.02em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        color,
        background: tint(color, solid ? 22 : 14)
      }
    },
    children
  )
}

function IconBtn({ icon, children, onClick, title, color, disabled }) {
  const [hover, setHover] = useState(false)
  const c = color || T.t2
  return h(
    'button',
    {
      type: 'button',
      title,
      onClick,
      disabled,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 24,
        padding: '0 8px',
        border: 0,
        borderRadius: 4,
        fontSize: 11,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        color: hover && !color ? T.t1 : c,
        background: color ? tint(color, hover ? 24 : 14) : hover ? tint(T.t1, 9) : 'transparent'
      }
    },
    icon ? h(Codicon, { name: icon, size: '0.8rem' }) : null,
    children
  )
}

// ── a small markdown renderer (headings, lists, tables, fences, quotes, inline code/bold/links) ─

function inline(text, keyBase, openLink) {
  const out = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*\s][^*]*\*)/g
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyBase}-${i++}`
    if (m[1]) {
      out.push(
        h(
          'code',
          {
            key,
            style: {
              padding: '1px 4px',
              borderRadius: 3,
              fontSize: '0.88em',
              color: 'var(--ui-inline-code-foreground, inherit)',
              background: 'var(--ui-inline-code-background, ' + tint(T.t1, 10) + ')'
            }
          },
          tok.slice(1, -1)
        )
      )
    } else if (m[2]) {
      out.push(h('strong', { key, style: { color: T.t1, fontWeight: 600 } }, inline(tok.slice(2, -2), key, openLink)))
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      out.push(
        h(
          'a',
          {
            key,
            href: mm[2],
            onClick: e => {
              e.preventDefault()
              openLink(mm[2])
            },
            style: { color: T.accent, cursor: 'pointer', textDecoration: 'none' }
          },
          mm[1]
        )
      )
    } else {
      out.push(h('em', { key }, tok.slice(1, -1)))
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isRow = l => /^\s*\|.*\|\s*$/.test(l)
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

function Markdown({ text, openLink }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const fence = /^```(\w*)/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(
        h('pre', { key: k++, style: { margin: '8px 0', padding: '8px 10px', borderRadius: 4, overflow: 'auto', fontSize: 11.5, lineHeight: 1.5, background: tint(T.t1, 7) } }, h('code', null, body.join('\n')))
      )
      continue
    }

    const hd = /^(#{1,4})\s+(.*)$/.exec(line)
    if (hd) {
      blocks.push(h('div', { key: k++, style: { margin: '12px 0 4px', fontWeight: 600, color: T.t1, fontSize: 14 - hd[1].length } }, inline(hd[2], `h${k}`, openLink)))
      i++
      continue
    }

    if (isRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
      const cell = (tag, c, j, r) => h(tag, { key: j, style: { textAlign: 'left', verticalAlign: 'top', padding: '6px 10px', borderTop: r ? `1px solid ${T.line}` : 0, fontWeight: tag === 'th' ? 600 : 400, color: tag === 'th' ? T.t1 : T.t2 } }, inline(c, `t${k}-${r}-${j}`, openLink))
      blocks.push(
        h('div', { key: k++, style: { margin: '8px 0', overflow: 'auto', border: `1px solid ${T.line}`, borderRadius: 4 } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
            h('thead', { style: { background: tint(T.t1, 6) } }, h('tr', null, head.map((c, j) => cell('th', c, j, 0)))),
            h('tbody', null, rows.map((r, ri) => h('tr', { key: ri }, r.map((c, j) => cell('td', c, j, ri + 1)))))
          )
        )
      )
      continue
    }

    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items = []
      while (i < lines.length && /^\s*(?:[-*]|\d+[.)])\s+/.test(lines[i])) {
        let t = lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*]|\d+[.)])\s+/.test(lines[i])) t += ' ' + lines[i++].trim()
        items.push(t)
      }
      blocks.push(
        h(ordered ? 'ol' : 'ul', { key: k++, style: { margin: '4px 0', paddingLeft: 20, listStyle: ordered ? 'decimal' : 'disc', color: T.t2 } },
          items.map((t, j) => h('li', { key: j, style: { margin: '3px 0', lineHeight: 1.55 } }, inline(t, `l${k}-${j}`, openLink))))
      )
      continue
    }

    if (/^>\s?/.test(line)) {
      const q = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(h('div', { key: k++, style: { margin: '6px 0', padding: '2px 10px', borderLeft: `2px solid ${T.line}`, color: T.t3 } }, inline(q.join(' '), `q${k}`, openLink)))
      continue
    }

    const para = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*(?:[-*]|\d+[.)])\s+)/.test(lines[i]) && !isRow(lines[i])) para.push(lines[i++])
    if (!para.length) { para.push(lines[i++]) }
    blocks.push(h('p', { key: k++, style: { margin: '6px 0', lineHeight: 1.6, color: T.t2 } }, inline(para.join(' '), `p${k}`, openLink)))
  }
  return h('div', { style: { fontSize: 13 } }, blocks)
}

// ── data + actions ──────────────────────────────────────────────────────────────────────────

const useQueue = (ctx, every = 30_000) => useQuery({ queryKey: [ctx.source, 'queue'], queryFn: () => ctx.rest('/queue'), refetchInterval: every })
const useLive = ctx => useQuery({ queryKey: [ctx.source, 'live'], queryFn: () => ctx.rest('/live', { timeoutMs: 90_000 }), refetchInterval: 300_000, staleTime: 60_000, retry: 1 })

const useRun = ctx => useQuery({ queryKey: [ctx.source, 'run'], queryFn: () => ctx.rest('/run'), refetchInterval: q => (q.state.data?.running ? 4_000 : 30_000) })

async function startRun(ctx, scope) {
  try {
    const st = await ctx.rest('/run', { method: 'POST', body: { scope } })
    queryClient.setQueryData([ctx.source, 'run'], st)
    host.notify({ kind: 'info', message: scope === 'co' ? 'Reviewing the codeowner review column…' : 'Running the reviews…' })
  } catch (err) {
    host.notify({ kind: 'error', message: `Could not start the run: ${err?.message || err}` })
  }
}

const refreshAll = ctx => queryClient.invalidateQueries({ queryKey: [ctx.source] })

async function refreshLive(ctx) {
  try {
    const data = await ctx.rest('/live?refresh=1', { timeoutMs: 90_000 })
    queryClient.setQueryData([ctx.source, 'live'], data)
  } catch (err) {
    host.notify({ kind: 'error', message: `Could not read GitHub: ${err?.message || err}` })
  }
}

const isGone = lv => lv && (lv.state === 'MERGED' || lv.state === 'CLOSED')
// A posted review is harvested by the skill (how the comments landed) before it may leave the watch list,
// so only pending entries, and posted ones already harvested, are offered for archiving.
const archivable = (e, lv) => isGone(lv) && (e.status === 'pending' || (e.status === 'posted' && e.harvested))
const goneStatus = lv => (lv.state === 'MERGED' ? 'merged' : 'closed')

const VERB = { merged: 'Marked merged', closed: 'Marked closed', discarded: 'Dismissed', posted: 'Marked posted', pending: 'Restored' }

// Undo of the last change, shared by the toast button and the `u` key.
let lastChange = null

async function setStatus(ctx, keys, status, { reason, quiet } = {}) {
  if (!keys.length) return []
  let res
  try {
    res = await ctx.rest('/status', { method: 'POST', body: { keys, status, reason: reason || null } })
  } catch (err) {
    host.notify({ kind: 'error', message: `Could not update the review queue: ${err?.message || err}` })
    return []
  }
  await refreshAll(ctx)
  const changed = res?.changed || []
  if (!changed.length) return changed
  lastChange = changed
  if (!quiet) {
    host.notify({
      kind: 'info',
      message: `${VERB[status] || 'Updated'} ${changed.length === 1 ? changed[0].key : `${changed.length} reviews`}`,
      action: { label: 'Undo', onClick: () => undo(ctx, changed) }
    })
  }
  return changed
}

async function undo(ctx, changed = lastChange) {
  if (!changed?.length) {
    host.notify({ kind: 'info', message: 'Nothing to undo' })
    return
  }
  lastChange = null
  const byPrev = {}
  for (const c of changed) (byPrev[c.prevStatus] ||= []).push(c.key)
  for (const [prev, keys] of Object.entries(byPrev)) await setStatus(ctx, keys, prev, { quiet: true })
  host.notify({ kind: 'info', message: `Undone: ${changed.length === 1 ? changed[0].key : `${changed.length} reviews`}` })
}

async function archiveGone(ctx, rows, live, quiet) {
  const merged = rows.filter(e => live[e.key]?.state === 'MERGED').map(e => e.key)
  const closed = rows.filter(e => live[e.key]?.state === 'CLOSED').map(e => e.key)
  const a = await setStatus(ctx, merged, 'merged', { quiet: true })
  const b = await setStatus(ctx, closed, 'closed', { quiet: true })
  const changed = [...a, ...b]
  lastChange = changed
  if (changed.length) {
    host.notify({
      kind: 'info',
      message: `${quiet ? 'Auto-archived' : 'Archived'} ${changed.length} review${changed.length === 1 ? '' : 's'} already ${closed.length ? 'merged or closed' : 'merged'} on GitHub`,
      action: { label: 'Undo', onClick: () => undo(ctx, changed) }
    })
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// A fresh chat with the prompt typed in, not sent: the skill shows the exact text before anything is posted.
async function openInChat(ctx, text) {
  host.newChat()
  for (let i = 0; i < 24; i++) {
    await sleep(250)
    try {
      if (await host.composer?.setDraft(null, text)) return
    } catch {}
  }
  const ok = await ctx.os.writeClipboard(text)
  host.notify({ kind: ok ? 'info' : 'error', message: ok ? 'Prompt copied: paste it into the new chat' : 'Could not fill the chat composer' })
}

// The review chat the board recorded (a Claude Code session): copy the command that resumes it.
async function copyResume(ctx, key) {
  let info
  try {
    info = await ctx.rest(`/chat?key=${encodeURIComponent(key)}`)
  } catch (err) {
    host.notify({ kind: 'error', message: `Could not look up the review chat: ${err?.message || err}` })
    return
  }
  if (!info?.found) {
    host.notify({ kind: 'error', message: `Session ${info?.id || ''} is not in ~/.claude/projects on this machine` })
    return
  }
  const ok = await ctx.os.writeClipboard(info.command)
  const where = info.cwdExists ? '' : ' (its worktree was removed, so this starts from the repo root)'
  host.notify({ kind: ok ? 'info' : 'error', message: ok ? `Copied: paste it in a terminal to resume the review chat${where}` : 'Clipboard unavailable', detail: info.command })
}

const postPrompt = (r, path) =>
  `Load the ${SKILL} skill and follow its Mode 2 "post", for ${r.key}. The draft is ${path}. Check the PR head still matches the draft, then show me the exact review body and inline comments before posting anything.`
const rereviewPrompt = (r, path, lv) =>
  `Load the ${SKILL} skill and re-review ${r.key}: its head moved from ${r.head} to ${lv.head}${lv.forcePushed ? ' (rebased or force-pushed)' : ''} since the draft ${path}. Review only the change, write the new draft and update state.json.`

// ── list column ─────────────────────────────────────────────────────────────────────────────

const selectStyle = {
  flex: 1,
  minWidth: 0,
  height: 24,
  padding: '0 4px',
  fontSize: 11,
  color: T.t2,
  background: tint(T.t1, 7),
  border: 0,
  borderRadius: 4
}

function Filters({ entries, f, set }) {
  const repos = [...new Set(entries.map(e => e.repo))].sort()
  const opt = (v, l) => h('option', { key: v, value: v }, l)
  return h('div', { style: { display: 'flex', gap: 4, padding: '0 10px 8px' } },
    h('select', { value: f.repo, onChange: e => set({ repo: e.target.value }), style: selectStyle }, opt('', 'Repo'), repos.map(r => opt(r, r))),
    h('select', { value: f.verdict, onChange: e => set({ verdict: e.target.value }), style: selectStyle }, opt('', 'Verdict'), Object.keys(VERDICT).map(v => opt(v, VERDICT[v].label))),
    h('select', { value: f.tier, onChange: e => set({ tier: e.target.value }), style: selectStyle }, opt('', 'Tier'), opt('sensitive', 'Sensitive'), opt('standard', 'Standard')),
    h('select', { value: f.sort, title: 'Sort', onChange: e => set({ sort: e.target.value }), style: selectStyle }, Object.entries(SORTS).map(([v, l]) => opt(v, l)))
  )
}

function liveBadges(lv) {
  if (!lv || lv.error) return []
  const out = []
  if (lv.state === 'MERGED') out.push(h(Pill, { key: 'm', color: 'var(--ui-purple)', solid: true, title: lv.mergedAt ? `Merged ${lv.mergedAt.slice(0, 10)}` : undefined }, 'merged on GitHub'))
  else if (lv.state === 'CLOSED') out.push(h(Pill, { key: 'c', color: T.t3, solid: true }, 'closed on GitHub'))
  else {
    if (lv.headMoved) {
      const n = lv.commitsAhead
      const label = lv.forcePushed ? 'rebased' : n ? `${n} new commit${n === 1 ? '' : 's'}` : 'head moved'
      out.push(h(Pill, { key: 'h', color: 'var(--ui-yellow)', title: `Draft at the reviewed head; the PR is now at ${lv.head}${n ? `, ${n} commits ahead` : ''}` }, h(Codicon, { name: 'history', size: '0.65rem' }), `stale · ${label}`))
    }
    if (lv.isDraft) out.push(h(Pill, { key: 'd', color: T.t3 }, 'draft'))
    if (lv.approvedBy?.length) out.push(h(Pill, { key: 'a', color: 'var(--ui-green)', title: `Approved by ${lv.approvedBy.join(', ')}` }, 'approved'))
    if (lv.checksFailed) out.push(h(Pill, { key: 'f', color: 'var(--ui-red)', title: `${lv.checksFailed} failing checks` }, 'checks failing'))
  }
  return out
}

function Row({ e, lv, active, checked, onPick, onCheck }) {
  const [hover, setHover] = useState(false)
  const v = verdictOf(e.verdict)
  const done = e.status !== 'pending'
  return h('div', {
    role: 'button',
    tabIndex: -1,
    'data-key': e.key,
    onClick: ev => (ev.metaKey || ev.shiftKey ? onCheck() : onPick()),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      gap: 8,
      width: '100%',
      textAlign: 'left',
      padding: '8px 12px 9px 8px',
      borderBottom: `1px solid ${T.line}`,
      cursor: 'pointer',
      opacity: done ? 0.6 : 1,
      boxShadow: active ? `inset 2px 0 0 ${T.accent}` : 'none',
      background: checked ? tint(T.accent, 18) : active ? tint(T.accent, 12) : hover ? tint(T.t1, 5) : 'transparent'
    }
  },
  h('input', {
    type: 'checkbox',
    checked,
    title: 'Select (x)',
    onClick: ev => ev.stopPropagation(),
    onChange: onCheck,
    style: { margin: '1px 0 0', flexShrink: 0, opacity: checked || hover ? 1 : 0.35, cursor: 'pointer' }
  }),
  h('div', { style: { flex: 1, minWidth: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: T.t3 } },
      h(Codicon, { name: 'git-pull-request', size: '0.75rem' }),
      h('span', null, `${e.repo}#${e.n}`),
      e.rereview ? h(Codicon, { name: 'sync', size: '0.7rem' }) : null,
      done ? h('span', { title: e.statusReason || undefined, style: { marginLeft: 'auto', textTransform: 'uppercase', fontSize: 9.5 } }, STATUS_LABEL[e.status] || e.status) : null),
    h('div', { style: { margin: '3px 0 5px', fontSize: 12.5, lineHeight: 1.35, color: T.t1 } }, e.title),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' } },
      h(Pill, { color: v.c, solid: true }, v.label),
      e.risk ? h(Pill, { color: RISK[e.risk] || T.t3 }, `${e.risk} risk`) : null,
      e.tier ? h(Pill, { color: TIER[e.tier] || T.t3 }, e.tier) : null,
      ...liveBadges(lv),
      h('span', { style: { fontSize: 10.5, color: T.t4 } }, (e.updatedAt || '').slice(0, 10)))))
}

function Banner({ color, icon, children, actions }) {
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 10px 8px', padding: '6px 8px', borderRadius: 4, fontSize: 11.5, lineHeight: 1.4, color: T.t2, background: tint(color, 12), border: `1px solid ${tint(color, 30)}` } },
    h(Codicon, { name: icon, size: '0.8rem', style: { color, flexShrink: 0 } }),
    h('div', { style: { flex: 1, minWidth: 0 } }, children),
    actions ? h('div', { style: { display: 'flex', gap: 4, flexShrink: 0 } }, actions) : null)
}

// ── detail ──────────────────────────────────────────────────────────────────────────────────

function Stat({ children, color }) {
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 10, fontSize: 11, color: color || T.t2, background: tint(color || T.t1, color ? 16 : 8) } }, children)
}

function Card({ id, n, title, accent, tag, collapsed, children }) {
  const [open, setOpen] = useState(!collapsed)
  return h('section', { id, style: { margin: '0 0 14px', borderRadius: 6, border: `1px solid ${tint(accent, 35)}`, borderLeft: `3px solid ${accent}`, background: tint(accent, 6) } },
    h('div', { onClick: () => setOpen(!open), style: { display: 'flex', alignItems: 'center', gap: 8, padding: open ? '9px 14px 0' : '9px 14px', fontSize: 13, fontWeight: 600, color: T.t1, cursor: 'pointer' } },
      h('span', { style: { display: 'inline-grid', placeItems: 'center', width: 18, height: 18, borderRadius: 4, fontSize: 10.5, color: accent, background: tint(accent, 22) } }, n),
      title,
      tag ? h(Pill, { color: tag.c }, tag.label) : null,
      h(Codicon, { name: open ? 'chevron-down' : 'chevron-right', size: '0.8rem', style: { marginLeft: 'auto', color: T.t3 } })),
    open ? h('div', { style: { padding: '2px 14px 10px' } }, children) : null)
}

// The report's sections keep the same colour in every draft; older drafts' sections fall back to the palette.
const NAMED_COLOR = {
  verdict: 'var(--ui-green)', impact: 'var(--ui-orange)', 'blast radius': 'var(--ui-orange)', 'at a glance': 'var(--ui-purple)',
  findings: 'var(--ui-yellow)', 'what the pr does': 'var(--ui-blue)', 'next steps': 'var(--ui-cyan)', evidence: 'var(--ui-text-tertiary)',
  'proposed review body': 'var(--ui-accent)', 'inline comments': 'var(--ui-red)'
}
const POSTED = new Set(['proposed review body', 'inline comments'])
const COLLAPSED = new Set(['evidence'])
const sectionColor = (name, i) => NAMED_COLOR[name.toLowerCase()] || SECTION_COLOR[i % SECTION_COLOR.length]
const postedTag = name => (POSTED.has(name.toLowerCase()) ? { label: 'posted to GitHub', c: 'var(--ui-accent)' } : null)

const SECTION_COLOR = ['var(--ui-green)', 'var(--ui-orange)', 'var(--ui-blue)', 'var(--ui-purple)', 'var(--ui-cyan)', 'var(--ui-yellow)', 'var(--ui-red)']
const slug = (s, i) => `rv-${i}-${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

function Inlines({ items, openLink }) {
  if (!items.length) return null
  return h('div', { style: { display: 'grid', gap: 8 } }, items.map((c, i) => {
    const sev = SEVERITY[String(c.severity || '').toLowerCase()] || T.t3
    return h('div', { key: i, style: { padding: '8px 10px', borderRadius: 4, background: tint(T.t1, 6) } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11, color: T.t3 } },
        c.severity ? h(Pill, { color: sev, solid: true }, c.severity) : null,
        c.id != null && typeof c.id === 'string' ? h('span', { style: { fontWeight: 600, color: T.t2 } }, c.id) : null,
        h('code', { style: { fontSize: 11 } }, `${c.path || '(general)'}${c.line ? ':' + c.line : ''}`)),
      h(Markdown, { text: c.body, openLink }))
  }))
}

function DismissForm({ onSubmit, onCancel }) {
  const [reason, setReason] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
    h('input', {
      ref,
      value: reason,
      placeholder: 'Why dismiss? (optional, feeds the weekly improve step)',
      onChange: e => setReason(e.target.value),
      onKeyDown: e => {
        if (e.key === 'Enter') onSubmit(reason)
        if (e.key === 'Escape') onCancel()
        e.stopPropagation()
      },
      style: { flex: 1, minWidth: 0, height: 24, padding: '0 8px', fontSize: 12, color: T.t1, background: tint(T.t1, 7), border: 0, borderRadius: 4, outline: 'none' }
    }),
    h(IconBtn, { icon: 'close', color: 'var(--ui-red)', onClick: () => onSubmit(reason) }, 'Dismiss'),
    h(IconBtn, { onClick: onCancel }, 'Cancel'))
}

function Detail({ ctx, k, lv, asking, setAsking }) {
  const q = useQuery({ queryKey: [ctx.source, 'draft', k], queryFn: () => ctx.rest(`/draft?key=${encodeURIComponent(k)}`), refetchInterval: 30_000 })
  const [mode, setMode] = useState('report')
  const openLink = u => ctx.os.openExternal(u)
  if (q.isLoading) return h('div', { style: { padding: 24, color: T.t3 } }, 'Loading…')
  if (q.error || !q.data) return h('div', { style: { padding: 24, color: T.t3 } }, 'Could not read this draft.')
  const { row: r, draft: d, markdown, path } = q.data
  const v = verdictOf(r.verdict)
  const sections = d.sections.filter(s => s.name !== 'Inline comments')
  const hasInline = d.inline.length > 0
  const navItems = [...sections.map((s, i) => ({ name: s.name, id: slug(s.name, i), c: sectionColor(s.name, i) })), ...(hasInline ? [{ name: `Inline comments (${d.inline.length})`, id: 'rv-inline', c: 'var(--ui-red)' }] : [])]
  const go = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const open = r.status === 'pending' || r.status === 'posted'
  const stale = lv && !lv.error && lv.state === 'OPEN' && lv.headMoved

  const actions = open
    ? [
        h(IconBtn, { key: 'm', icon: 'git-merge', color: lv?.state === 'MERGED' ? 'var(--ui-purple)' : undefined, title: 'Mark merged (m)', onClick: () => setStatus(ctx, [k], 'merged') }, 'Merged'),
        r.status === 'pending' ? h(IconBtn, { key: 'd', icon: 'close', title: 'Dismiss: won\'t post this draft (e)', onClick: () => setAsking(true) }, 'Dismiss') : null,
        r.status === 'pending' ? h(IconBtn, { key: 'p', icon: 'check', title: 'I posted this review myself (p)', onClick: () => setStatus(ctx, [k], 'posted') }, 'Posted') : null
      ]
    : [h(IconBtn, { key: 'r', icon: 'discard', title: 'Back to the queue (u)', onClick: () => setStatus(ctx, [k], r.prevStatus && r.prevStatus !== r.status ? r.prevStatus : 'pending') }, `Restore${r.prevStatus && r.prevStatus !== 'pending' ? ` to ${STATUS_LABEL[r.prevStatus] || r.prevStatus}` : ''}`)]

  return h('div', { style: { height: '100%', overflow: 'auto' } },
    h('div', { style: { position: 'sticky', top: 0, zIndex: 2, padding: '10px 18px 8px', borderBottom: `1px solid ${T.line}`, background: 'var(--ui-bg-editor, var(--ui-base))' } },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.35, color: T.t1 } }, `${r.repo}#${r.n} — ${r.title}`),
          h('div', { style: { marginTop: 3, fontSize: 11, color: T.t3 } }, [r.author, r.head && `head ${r.head}`, r.jira, (r.updatedAt || '').slice(0, 10), STATUS_LABEL[r.status] || r.status, r.statusReason && `“${r.statusReason}”`].filter(Boolean).join(' · '))),
        h('div', { style: { display: 'flex', gap: 2, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } },
          ...actions,
          h('span', { style: { width: 1, margin: '4px 4px', background: T.line } }),
          r.url ? h(IconBtn, { icon: 'link-external', title: 'Open PR (o)', onClick: () => openLink(r.url) }, 'Open PR') : null,
          r.status === 'pending' && path ? h(IconBtn, { icon: 'comment-discussion', title: 'Start a chat that posts this review through the skill (you confirm the text first)', onClick: () => openInChat(ctx, postPrompt(r, path)) }, 'Post in chat') : null,
          r.chat ? h(IconBtn, { icon: 'terminal', title: 'Copy the command that resumes the Claude Code session this review came from', onClick: () => copyResume(ctx, k) }, 'Review chat') : null,
          h(IconBtn, { icon: 'copy', title: 'Copy draft path', onClick: () => ctx.os.writeClipboard(path).then(ok => host.notify({ kind: ok ? 'info' : 'error', message: ok ? 'Draft path copied' : 'Clipboard unavailable' })) }),
          h(IconBtn, { icon: 'folder-opened', title: 'Reveal draft', onClick: () => ctx.os.revealPath(path) }),
          h(IconBtn, { icon: mode === 'report' ? 'markdown' : 'preview', title: mode === 'report' ? 'Raw markdown' : 'Report view', onClick: () => setMode(mode === 'report' ? 'md' : 'report') }))),
      asking ? h(DismissForm, { onCancel: () => setAsking(false), onSubmit: reason => { setAsking(false); setStatus(ctx, [k], 'discarded', { reason }) } }) : null,
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
        h(Pill, { color: v.c, solid: true }, v.label),
        r.tier ? h(Pill, { color: TIER[r.tier] || T.t3 }, r.tier) : null,
        r.risk ? h(Pill, { color: RISK[r.risk] || T.t3, solid: true }, `${r.risk} risk`) : null,
        ...(r.counts
          ? COUNT_ORDER.map(([k, label]) => h(Stat, { key: k, color: r.counts[k] ? SEVERITY[k] : null }, `${r.counts[k] || 0} ${label}`))
          : [h(Stat, { key: 'b', color: r.blocking ? 'var(--ui-red)' : null }, `${r.blocking} blockers`)]),
        h(Stat, null, `${r.inline} inline comments`),
        r.rereview ? h(Stat, null, 're-review') : null,
        ...liveBadges(lv)),
      stale
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '6px 8px', borderRadius: 4, fontSize: 11.5, color: T.t2, background: tint('var(--ui-yellow)', 12) } },
            h(Codicon, { name: 'warning', size: '0.8rem', style: { color: 'var(--ui-yellow)' } }),
            h('span', { style: { flex: 1 } }, `This draft reviewed ${r.head}; the PR is now at ${lv.head}${lv.commitsAhead ? ` (${lv.commitsAhead} commit${lv.commitsAhead === 1 ? '' : 's'} ahead)` : ''}${lv.forcePushed ? ', rebased or force-pushed' : ''}. Line anchors may be off: re-review before posting.`),
            path ? h(IconBtn, { icon: 'sync', color: 'var(--ui-yellow)', onClick: () => openInChat(ctx, rereviewPrompt(r, path, lv)) }, 'Re-review in chat') : null)
        : null),
    mode === 'md'
      ? h('pre', { style: { margin: 0, padding: '16px 18px', fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: T.t2 } }, markdown)
      : h('div', { style: { display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: 18, padding: '14px 18px 40px', alignItems: 'start' } },
        h('nav', { style: { position: 'sticky', top: 120, display: 'grid', gap: 4 } }, navItems.map((n, i) =>
          h('button', { key: n.id, type: 'button', onClick: () => go(n.id), style: { textAlign: 'left', padding: '5px 8px', border: 0, borderLeft: `3px solid ${n.c}`, borderRadius: 3, fontSize: 11.5, cursor: 'pointer', color: T.t2, background: tint(T.t1, 6) } }, `${i + 1} ${n.name}`))),
        h('div', { style: { minWidth: 0 } },
          sections.map((s, i) => h(Card, { key: s.name, id: slug(s.name, i), n: i + 1, title: s.name, accent: sectionColor(s.name, i), tag: postedTag(s.name), collapsed: COLLAPSED.has(s.name.toLowerCase()) }, h(Markdown, { text: s.body, openLink }))),
          hasInline ? h(Card, { id: 'rv-inline', n: navItems.length, title: `Inline comments (${d.inline.length})`, accent: 'var(--ui-red)', tag: postedTag('inline comments') }, h(Inlines, { items: d.inline, openLink })) : null,
          d.inlineBad ? h('div', { style: { color: T.t3, fontSize: 12 } }, 'The inline comments block does not parse as JSON; see the MD view.') : null)))
}

function Digest({ text, ctx }) {
  return h('div', { style: { height: '100%', overflow: 'auto', padding: '14px 18px 40px' } },
    h('div', { style: { fontSize: 14, fontWeight: 600, color: T.t1, marginBottom: 6 } }, 'Latest digest (latest.md)'),
    text ? h(Markdown, { text, openLink: u => ctx.os.openExternal(u) }) : h('div', { style: { color: T.t3 } }, 'No digest yet.'))
}

// ── page ────────────────────────────────────────────────────────────────────────────────────

function sortRows(rows, sort) {
  const t = e => e.updatedAt || ''
  const cmp = {
    tier: (a, b) => (TIER_RANK[a.tier] ?? 2) - (TIER_RANK[b.tier] ?? 2) || t(b).localeCompare(t(a)),
    newest: (a, b) => t(b).localeCompare(t(a)),
    oldest: (a, b) => t(a).localeCompare(t(b)),
    priority: (a, b) => (a.priority ?? 999) - (b.priority ?? 999) || t(b).localeCompare(t(a))
  }[sort] || ((a, b) => t(b).localeCompare(t(a)))
  return [...rows].sort((a, b) => (a.status !== 'pending') - (b.status !== 'pending') || cmp(a, b))
}

const SHORTCUTS = 'j/k move · x select · m merged · e dismiss · p posted · u undo · o open PR · / search · r refresh GitHub'

function ReviewsPage({ ctx }) {
  const q = useQueue(ctx)
  const lq = useLive(ctx)
  const [f, setF] = useState(() => ({ repo: '', verdict: '', tier: '', archived: false, sort: 'tier', autoArchive: false, ...ctx.storage.get('filters', {}), text: '' }))
  const [sel, setSel] = useState(() => ctx.storage.get('selected', null))
  const [checked, setChecked] = useState(() => new Set())
  const [asking, setAsking] = useState(false)
  const [digest, setDigest] = useState(false)
  const searchRef = useRef(null)
  const rootRef = useRef(null)
  const set = p => setF(prev => {
    const n = { ...prev, ...p }
    ctx.storage.set('filters', { repo: n.repo, verdict: n.verdict, tier: n.tier, archived: n.archived, sort: n.sort, autoArchive: n.autoArchive })
    return n
  })
  const entries = q.data?.entries || []
  const live = lq.data?.live || {}

  const shown = useMemo(() => {
    const words = f.text.toLowerCase().split(/\s+/).filter(Boolean)
    return sortRows(entries.filter(e => (f.archived || e.status === 'pending') && (!f.repo || e.repo === f.repo) && (!f.verdict || String(e.verdict).toLowerCase() === f.verdict) && (!f.tier || e.tier === f.tier) &&
      words.every(w => `${e.repo}#${e.n} ${e.title} ${e.author} ${e.jira} ${e.theme || ''}`.toLowerCase().includes(w))), f.sort)
  }, [entries, f])

  const active = shown.find(e => e.key === sel) ? sel : shown[0]?.key || null
  useEffect(() => { if (active && active !== sel) setSel(active) }, [active])
  useEffect(() => { setAsking(false) }, [active])
  const pick = key => { setSel(key); setDigest(false); ctx.storage.set('selected', key) }
  const toggle = key => setChecked(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  // Drop selections that left the list (archived, filtered out).
  useEffect(() => { setChecked(prev => { const ok = new Set(shown.map(e => e.key)); const n = new Set([...prev].filter(k => ok.has(k))); return n.size === prev.size ? prev : n }) }, [shown])

  const gone = entries.filter(e => archivable(e, live[e.key]))
  const goneSig = gone.map(e => e.key).join(',')
  const pending = entries.filter(e => e.status === 'pending' && !isGone(live[e.key])).length
  const stale = entries.filter(e => e.status === 'pending' && live[e.key]?.state === 'OPEN' && live[e.key]?.headMoved).length

  // Auto-archive what GitHub says is merged or closed, once per distinct set.
  const autoDone = useRef('')
  useEffect(() => {
    if (!f.autoArchive || !goneSig || autoDone.current === goneSig) return
    autoDone.current = goneSig
    archiveGone(ctx, gone, live, true)
  }, [f.autoArchive, goneSig])

  // Targets of a bulk/keyboard action: the checked rows, else the active one.
  const targets = () => (checked.size ? [...checked] : active ? [active] : [])

  // Keyboard: single keys, no modifiers, never while typing; only while this page is on screen.
  const live$ = useRef({})
  live$.current = { shown, active, targets, live, entries, checkedCount: checked.size }
  useEffect(() => {
    const onKey = ev => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const t = ev.target
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (!rootRef.current || !rootRef.current.offsetParent) return
      const s = live$.current
      const idx = s.shown.findIndex(e => e.key === s.active)
      const move = d => {
        const next = s.shown[Math.max(0, Math.min(s.shown.length - 1, idx + d))]
        if (next) { pick(next.key); rootRef.current.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' }) }
      }
      const row = s.entries.find(e => e.key === s.active)
      const keys = s.targets()
      const act = {
        j: () => move(1), k: () => move(-1),
        x: () => s.active && toggle(s.active),
        m: () => setStatus(ctx, keys, 'merged'),
        // One open review asks for a reason; a selection is dismissed at once (Undo is in the toast).
        e: () => (s.checkedCount ? setStatus(ctx, keys, 'discarded') : row?.status === 'pending' && setAsking(true)),
        p: () => setStatus(ctx, keys.filter(k => s.entries.find(e => e.key === k)?.status === 'pending'), 'posted'),
        u: () => undo(ctx),
        o: () => {
          const url = row && (row.url || '')
          if (url) ctx.os.openExternal(url)
        },
        r: () => refreshLive(ctx),
        '/': () => searchRef.current?.focus(),
        Escape: () => { setChecked(new Set()); setAsking(false) }
      }[ev.key]
      if (act) { ev.preventDefault(); act() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (q.isLoading) return h('div', { style: { padding: 24, color: T.t3 } }, 'Loading reviews…')
  if (q.data && !q.data.exists) return h('div', { style: { padding: 24, color: T.t3 } }, `No review queue at ${q.data.dir}. Run the review-queue skill first.`)
  if (q.error || !q.data) return h('div', { style: { padding: 24, color: T.t3, lineHeight: 1.6 } }, 'The Reviews backend did not answer. Add "reviews" to plugins.enabled in ~/.hermes/config.yaml and restart the gateway.')

  const liveNote = lq.isFetching ? 'checking GitHub…' : lq.data?.available === false ? 'gh not found' : lq.error ? 'GitHub check failed' : ''

  return h('div', { ref: rootRef, style: { display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)', height: '100%', minHeight: 0 } },
    h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: `1px solid ${T.line}` } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 0 12px' } },
        h(IconBtn, { icon: running ? 'sync' : 'play', color: T.accent, disabled: running, title: 'Review every ticket in review on the board', onClick: () => startRun(ctx, 'all') }, running && run.data.scope === 'all' ? 'Running…' : 'Run the reviews'),
        h(IconBtn, { icon: running ? 'sync' : 'play', color: T.accent, disabled: running, title: 'Review only the tickets in the codeowner review column', onClick: () => startRun(ctx, 'co') }, running && run.data.scope === 'co' ? 'Running…' : 'Run codeowner review only')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 10px 6px 12px', fontSize: 11, color: T.t3 } },
        h('span', { title: SHORTCUTS, style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          `${pending} pending${stale ? ` · ${stale} stale` : ''} · ${entries.length - entries.filter(e => e.status === 'pending').length} archived`, liveNote ? ` · ${liveNote}` : ''),
        h(IconBtn, { icon: 'refresh', title: 'Re-check GitHub (r)', onClick: () => refreshLive(ctx) }),
        h(IconBtn, { icon: 'notebook', title: 'Latest digest', color: digest ? T.accent : undefined, onClick: () => setDigest(!digest) }),
        h(IconBtn, { icon: f.archived ? 'eye' : 'eye-closed', title: f.archived ? 'Hide archived' : 'Show archived', onClick: () => set({ archived: !f.archived }) }, f.archived ? 'Archived' : null)),
      h('div', { style: { padding: '0 10px 6px' } },
        h('input', {
          ref: searchRef,
          value: f.text,
          placeholder: 'Search reviews…  ( / )',
          onChange: e => set({ text: e.target.value }),
          onKeyDown: e => { if (e.key === 'Escape') e.currentTarget.blur() },
          style: { width: '100%', height: 26, padding: '0 8px', fontSize: 12, color: T.t1, background: tint(T.t1, 7), border: 0, borderRadius: 4, outline: 'none' }
        })),
      h(Filters, { entries, f, set }),
      gone.length && !f.autoArchive
        ? h(Banner, {
            color: 'var(--ui-purple)',
            icon: 'git-merge',
            actions: [
              h(IconBtn, { key: 'a', color: 'var(--ui-purple)', onClick: () => archiveGone(ctx, gone, live, false) }, 'Archive'),
              h(IconBtn, { key: 'auto', title: 'Archive merged and closed PRs automatically from now on', onClick: () => set({ autoArchive: true }) }, 'Always')
            ]
          }, `${gone.length} review${gone.length === 1 ? ' is' : 's are'} already merged or closed on GitHub: ${gone.map(e => e.key).join(', ')}`)
        : null,
      checked.size
        ? h(Banner, {
            color: T.accent,
            icon: 'checklist',
            actions: [
              h(IconBtn, { key: 'm', icon: 'git-merge', title: 'm', onClick: () => setStatus(ctx, [...checked], 'merged') }, 'Merged'),
              h(IconBtn, { key: 'd', icon: 'close', title: 'e', onClick: () => setStatus(ctx, [...checked], 'discarded') }, 'Dismiss'),
              h(IconBtn, { key: 'c', title: 'Esc', onClick: () => setChecked(new Set()) }, 'Clear')
            ]
          }, `${checked.size} selected`)
        : null,
      h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', borderTop: `1px solid ${T.line}` } },
        shown.length
          ? shown.map(e => h(Row, { key: e.key, e, lv: live[e.key], active: e.key === active && !digest, checked: checked.has(e.key), onPick: () => pick(e.key), onCheck: () => toggle(e.key) }))
          : h('div', { style: { padding: 16, fontSize: 12, color: T.t3 } }, 'Nothing matches.')),
      h('div', { style: { padding: '5px 12px', borderTop: `1px solid ${T.line}`, fontSize: 10, color: T.t4, display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: SHORTCUTS }, SHORTCUTS),
        f.autoArchive ? h('button', { type: 'button', title: 'Stop archiving merged/closed PRs automatically', onClick: () => set({ autoArchive: false }), style: { border: 0, padding: 0, background: 'transparent', cursor: 'pointer', fontSize: 10, color: T.t3 } }, 'auto-archive on ✕') : null)),
    h('div', { style: { minWidth: 0, minHeight: 0 } },
      digest
        ? h(Digest, { text: q.data.digest, ctx })
        : active
          ? h(Detail, { key: active, ctx, k: active, lv: live[active], asking, setAsking })
          : h('div', { style: { padding: 24, color: T.t3 } }, 'No review selected.')))
}

// ── status bar chip ─────────────────────────────────────────────────────────────────────────

function Chip({ ctx }) {
  const q = useQueue(ctx, 60_000)
  const lq = useLive(ctx)
  const live = lq.data?.live || {}
  const pending = (q.data?.entries || []).filter(e => e.status === 'pending' && !isGone(live[e.key]))
  if (!pending.length) return null
  const blocking = pending.filter(e => String(e.verdict).toLowerCase() === 'blocking').length
  const stale = pending.filter(e => live[e.key]?.headMoved).length
  return h('button', { type: 'button', title: `${pending.length} reviews pending${blocking ? `, ${blocking} blocking` : ''}${stale ? `, ${stale} stale` : ''}`, onClick: () => host.navigate(PATH), style: { display: 'inline-flex', alignItems: 'center', gap: 4, height: '100%', padding: '0 6px', border: 0, background: 'transparent', cursor: 'pointer', fontSize: 11, color: T.t3 } },
    h(Codicon, { name: 'git-pull-request', size: '0.7rem' }), pending.length,
    blocking ? h('span', { style: { color: 'var(--ui-red)' } }, `· ${blocking}`) : null)
}

export default {
  id: ID,
  name: 'Reviews',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => h(ReviewsPage, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Reviews', codicon: 'git-pull-request' } },
      { id: 'chip', area: 'statusBar.right', order: 120, render: () => h(Chip, { ctx }) },
      { id: 'cmd', area: PALETTE_AREA, data: { id: 'reviews.open', label: 'Open Reviews', keywords: ['pr', 'review queue'], run: () => host.navigate(PATH) } },
      { id: 'cmd-refresh', area: PALETTE_AREA, data: { id: 'reviews.refresh', label: 'Reviews: re-check GitHub', keywords: ['pr', 'merged', 'stale'], run: () => refreshLive(ctx) } }
    ])
  }
}
