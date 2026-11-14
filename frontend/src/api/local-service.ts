import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 图表发布准入：逐条核对热力方案状态、聚合级别与样本覆盖率，不通过就返回具体拒绝原因。
function checkChartPublish(row: EntryRow): { reason: string | null; plan: EntryRow | null } {
  const code = String(row['配置编号'] ?? row.id)
  const status = String(row.status)
  if (status === '已发布') {
    const publishNo = String(row['发布号'] ?? '') || '（未记录）'
    const conclusion = String(row['发布结论'] ?? '')
    return {
      reason: `图表 ${code} 已发布，首个完整发布号 ${publishNo} 生效中，后续发布请求只能查看并沿用该结论${conclusion ? `：${conclusion}` : ''}`,
      plan: null,
    }
  }
  if (status !== '配置评审中') {
    return { reason: `图表 ${code} 当前状态「${status}」，须先完成配置评审才能发布`, plan: null }
  }
  const planCode = String(row['关联热力方案'] ?? '').trim()
  if (!planCode) {
    return { reason: `图表 ${code} 未关联热力方案，不能发布`, plan: null }
  }
  const plan = listRows('heatmap').find((item) => String(item['方案编号']) === planCode) ?? null
  if (!plan) {
    return { reason: `图表 ${code} 关联的热力方案 ${planCode} 不存在，不能发布`, plan: null }
  }
  const planStatus = String(plan.status)
  if (planStatus === '已归档') {
    return { reason: `热力方案 ${planCode} 已归档转历史：已发布热力结果保留，但禁止新图表发布`, plan }
  }
  if (planStatus !== '已启用') {
    return { reason: `热力方案 ${planCode} 当前状态「${planStatus}」，须完成评审并启用后才能供图表发布使用`, plan }
  }
  const chartLevel = String(row['聚合级别'] ?? '').trim() || '未配置'
  const planLevel = String(plan['聚合级别'] ?? '').trim() || '未配置'
  if (chartLevel !== planLevel) {
    return { reason: `聚合级别不一致：图表 ${code} 读取「${chartLevel}」，热力方案 ${planCode} 为「${planLevel}」，不能发布`, plan }
  }
  const coverage = Number(row['样本覆盖率'])
  const minSample = Number(plan['最小样本'])
  if (!Number.isFinite(coverage)) {
    return { reason: `图表 ${code} 缺少有效的样本覆盖率，不能发布`, plan }
  }
  if (Number.isFinite(minSample) && coverage < minSample) {
    return { reason: `样本覆盖率不足：图表 ${code} 为 ${coverage}%，低于热力方案 ${planCode} 要求的最小样本 ${minSample}%，不能发布`, plan }
  }
  return { reason: null, plan }
}

// 发布号按图表递增：首次发布为 PUB-<配置编号>-1；已发布期间的重复请求不另发号，下线重发才递增。
function nextPublishNo(row: EntryRow): string {
  const code = String(row['配置编号'] ?? `ID-${row.id}`)
  const matched = String(row['发布号'] ?? '').match(/-(\d+)$/)
  const seq = matched ? Number(matched[1]) + 1 : 1
  return `PUB-${code}-${seq}`
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 先对齐浏览器里的最新提交：并发发布时以完整校验通过并率先落库的版本为准。
  refreshRows()
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const extra: Record<string, string> = {}
  let suffix = ''
  if (key === 'dataviz' && action === '发布图表') {
    const { reason, plan } = checkChartPublish(rows[index])
    if (reason) {
      return { ok: false, message: reason }
    }
    // 校验全部通过：发布号、方案引用快照与图表状态在一次提交里一起落库，保证两边一致。
    const publishNo = nextPublishNo(rows[index])
    extra['发布号'] = publishNo
    extra['发布结论'] = `按热力方案 ${String(rows[index]['关联热力方案'])}（已启用，聚合级别 ${String(plan?.['聚合级别'] ?? '')}）发布，样本覆盖率 ${String(rows[index]['样本覆盖率'])}% 达到最小样本 ${String(plan?.['最小样本'] ?? '')}%；历史图表按此发布快照解释`
    suffix = `，发布号 ${publishNo}`
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    ...extra,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
