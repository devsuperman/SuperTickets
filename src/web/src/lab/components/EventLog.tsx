import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { seconds } from './format'
import type { LogEntry } from './usePlayer'

const SHOWN = 400

/** Every SimEvent, oldest first; click a correlation id to follow one request across services. */
export function EventLog({ log }: { log: LogEntry[] }) {
  const [filter, setFilter] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const rows = (filter ? log.filter((e) => e.correlationId === filter) : log).slice(-SHOWN)

  // Stick to the bottom unless the reader scrolled up.
  const last = rows.length > 0 ? rows[rows.length - 1].seq : -1
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [last])
  const onScroll = () => {
    const el = box.current!
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="space-y-2">
      {filter && (
        <div className="flex items-center gap-2 text-sm">
          Following <code className="rounded bg-muted px-1">{filter}</code>
          <Button size="sm" variant="ghost" onClick={() => setFilter(null)}><X /> Clear</Button>
        </div>
      )}
      <div ref={box} onScroll={onScroll} className="max-h-80 overflow-auto rounded-md border font-mono text-xs">
        {rows.length === 0 && <p className="p-3 text-muted-foreground">Nothing yet. Press Run or Step.</p>}
        {rows.map((e) => (
          <div key={e.seq} className={cn('flex items-start gap-2 border-b px-2 py-1 last:border-0', e.error && 'bg-destructive/10')}>
            <span className="w-20 shrink-0 text-muted-foreground">{seconds(e.t)}</span>
            <span className="w-40 shrink-0 truncate">{e.from === e.to ? e.from : `${e.from} → ${e.to}`}</span>
            <Badge variant={e.error ? 'destructive' : 'outline'} className="w-16 shrink-0">{e.kind}</Badge>
            <span className={cn('min-w-0 flex-1 break-words', e.error && 'text-destructive')}>{e.label}</span>
            {e.correlationId && (
              <button
                type="button" title="Follow this correlation id" onClick={() => setFilter(e.correlationId!)}
                className="shrink-0 text-muted-foreground hover:text-foreground hover:underline"
              >
                {e.correlationId.slice(0, 13)}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
