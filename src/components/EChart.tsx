import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, GraphChart, HeatmapChart, LineChart } from 'echarts/charts'
import { CalendarComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import 'echarts-wordcloud'

echarts.use([BarChart, GraphChart, HeatmapChart, LineChart, CalendarComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, CanvasRenderer])

type Handler = (p: { data?: unknown; name?: string; dataType?: string }) => void

export default function EChart({ option, height = 420, onClick, onDblClick }: { option: Record<string, unknown>; height?: number; onClick?: Handler; onDblClick?: Handler }) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const handlers = useRef({ onClick, onDblClick })
  handlers.current = { onClick, onDblClick }

  useEffect(() => {
    if (!el.current) return
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' })
    chart.current = c
    c.on('click', (p) => handlers.current.onClick?.(p as Parameters<Handler>[0]))
    c.on('dblclick', (p) => handlers.current.onDblClick?.(p as Parameters<Handler>[0]))
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(el.current)
    return () => { ro.disconnect(); c.dispose(); chart.current = null }
  }, [])

  useEffect(() => { chart.current?.setOption(option, true) }, [option])

  return <div ref={el} style={{ height }} className="w-full" />
}

export const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
export const KAI = '"LXGW WenKai", "KaiTi", "STKaiti", serif'
export const C = { ink: '#1f2a37', soft: '#5b6573', faint: '#8a929c', pen: '#24426b', red: '#c8412f', ok: '#2f8f5b', warn: '#b7791f', rule: '#d8ddd2', grid: '#e4e8df' }
