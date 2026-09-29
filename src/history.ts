import type { Scene, SceneEditChange, SceneEditEntry, SceneEditField, Script } from './types'

const newId = () => `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 打开中的编辑记录超过该时长未再改动，则在下一次改动时自动归档。 */
const OPEN_TTL_MS = 15 * 60 * 1000

export const FIELD_LABELS: Record<SceneEditField, string> = {
  number: '场号',
  slug: '场名',
  synopsis: '摘要',
  intExt: '内外景',
  location: '地点',
  dayNight: '日夜',
  storyTime: '故事时间',
  pageLength: '页数',
  revision: '修订色',
  status: '场次状态',
  characterIds: '出场角色',
  propIds: '出场道具',
  costumes: '服装',
  order: '场次顺序'
}

const REVISION_LABELS: Record<string, string> = {
  white: '白纸', blue: '蓝', pink: '粉', yellow: '黄', green: '绿',
  goldenrod: '金菊', buff: '浅黄', salmon: '鲑粉', cherry: '樱桃'
}

const STATUS_LABELS: Record<string, string> = { draft: '草稿', review: '待审', locked: '锁定' }

const SCALAR_FIELDS: Array<{ key: keyof Scene; field: SceneEditField; format?: (value: string) => string }> = [
  { key: 'number', field: 'number' },
  { key: 'slug', field: 'slug' },
  { key: 'synopsis', field: 'synopsis' },
  { key: 'intExt', field: 'intExt' },
  { key: 'location', field: 'location' },
  { key: 'dayNight', field: 'dayNight' },
  { key: 'storyTime', field: 'storyTime' },
  { key: 'pageLength', field: 'pageLength' },
  { key: 'revision', field: 'revision', format: (value) => REVISION_LABELS[value] ?? value },
  { key: 'status', field: 'status', format: (value) => STATUS_LABELS[value] ?? value }
]

const blank = '（空）'
export function displayValue(value: string) {
  return value === '' ? blank : value
}

function characterName(script: Script, characterId: string) {
  return script.characters.find((item) => item.id === characterId)?.name ?? '已删除角色'
}

function propName(script: Script, propId: string) {
  return script.props.find((item) => item.id === propId)?.name ?? '已删除道具'
}

function wardrobeName(script: Script, wardrobeId: string) {
  return script.wardrobes.find((item) => item.id === wardrobeId)?.name ?? '已删除服装'
}

function setEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value) => b.includes(value))
}

/** 对比同一场次改前改后，只产出实际发生变化的字段；角色/道具/服装逐个目标列出。 */
export function diffScene(before: Scene, after: Scene, script: Script): SceneEditChange[] {
  const changes: SceneEditChange[] = []

  SCALAR_FIELDS.forEach(({ key, field, format }) => {
    const beforeValue = String(before[key] ?? '')
    const afterValue = String(after[key] ?? '')
    if (beforeValue !== afterValue) {
      changes.push({
        field,
        before: format ? format(beforeValue) || beforeValue : beforeValue,
        after: format ? format(afterValue) || afterValue : afterValue
      })
    }
  })

  if (!setEqual(before.characterIds, after.characterIds)) {
    const union = [...new Set([...before.characterIds, ...after.characterIds])]
    union.forEach((characterId) => {
      const wasIn = before.characterIds.includes(characterId)
      const isIn = after.characterIds.includes(characterId)
      if (wasIn === isIn) return
      changes.push({
        field: 'characterIds',
        targetKey: characterId,
        before: wasIn ? characterName(script, characterId) : blank,
        after: isIn ? characterName(script, characterId) : blank
      })
    })
  }

  if (!setEqual(before.propIds, after.propIds)) {
    const union = [...new Set([...before.propIds, ...after.propIds])]
    union.forEach((propId) => {
      const wasIn = before.propIds.includes(propId)
      const isIn = after.propIds.includes(propId)
      if (wasIn === isIn) return
      changes.push({
        field: 'propIds',
        targetKey: propId,
        before: wasIn ? propName(script, propId) : blank,
        after: isIn ? propName(script, propId) : blank
      })
    })
  }

  const costumeKeys = [...new Set([...Object.keys(before.costumes), ...Object.keys(after.costumes)])]
  costumeKeys.forEach((characterId) => {
    const beforeWardrobe = before.costumes[characterId] ?? ''
    const afterWardrobe = after.costumes[characterId] ?? ''
    if (beforeWardrobe === afterWardrobe) return
    changes.push({
      field: 'costumes',
      targetKey: characterId,
      before: beforeWardrobe ? wardrobeName(script, beforeWardrobe) : '未指定',
      after: afterWardrobe ? wardrobeName(script, afterWardrobe) : '未指定'
    })
  })

  return changes
}

export function changeKey(change: SceneEditChange) {
  return `${change.field}|${change.targetKey ?? ''}`
}

/** 把新改动并入一条记录：同字段覆盖改后值，完全改回原值的改动剔除。 */
export function mergeChanges(existing: SceneEditChange[], incoming: SceneEditChange[]): SceneEditChange[] {
  const merged = new Map(existing.map((change) => [changeKey(change), { ...change }]))
  incoming.forEach((change) => {
    const key = changeKey(change)
    const previous = merged.get(key)
    if (!previous) {
      merged.set(key, { ...change })
    } else if (previous.before === change.after) {
      merged.delete(key)
    } else {
      previous.after = change.after
    }
  })
  return [...merged.values()]
}

function closeEntry(script: Script, entry: SceneEditEntry, nowIso: string, fallbackReason: string, syncReason: boolean) {
  entry.open = false
  entry.updatedAt = nowIso
  if (!entry.reason.trim()) entry.reason = fallbackReason
  if (syncReason) {
    const scene = script.scenes.find((item) => item.id === entry.sceneId)
    if (scene && entry.reason.trim()) scene.reason = entry.reason
  }
}

/** 归档全部打开中的记录；快照与恢复旧版前调用。 */
export function closeOpenEdits(script: Script, fallbackReason = '（未填写原因）') {
  const nowIso = new Date().toISOString()
  script.sceneEdits.forEach((entry) => {
    if (entry.open) closeEntry(script, entry, nowIso, fallbackReason, true)
  })
}

/** 归档指定场次的打开记录（切换场次、手动完成）。 */
export function closeSceneEdits(script: Script, sceneId: string, fallbackReason = '（未填写原因）') {
  const nowIso = new Date().toISOString()
  script.sceneEdits.forEach((entry) => {
    if (entry.open && entry.sceneId === sceneId) closeEntry(script, entry, nowIso, fallbackReason, true)
  })
}

/**
 * 把对一场的改动并入编辑记录：归档其它场次的打开记录与本场超时记录，
 * 然后创建或续记本场的打开记录。所有改动都被改回原值时不保留记录。
 */
export function applySceneChanges(script: Script, sceneId: string, incoming: SceneEditChange[], reason: string, author: string): boolean {
  if (!incoming.length) return false
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  script.sceneEdits.forEach((entry) => {
    if (!entry.open) return
    const stale = now - new Date(entry.updatedAt).getTime() > OPEN_TTL_MS
    if (entry.sceneId !== sceneId || stale) closeEntry(script, entry, nowIso, '（未填写原因）', true)
  })

  let entry = script.sceneEdits.find((item) => item.open && item.sceneId === sceneId)
  if (!entry) {
    entry = {
      id: newId(),
      sceneId,
      sceneNumber: script.scenes.find((scene) => scene.id === sceneId)?.number ?? '',
      createdAt: nowIso,
      updatedAt: nowIso,
      author: author || '未署名',
      reason,
      open: true,
      changes: []
    }
    script.sceneEdits.push(entry)
  } else {
    entry.updatedAt = nowIso
    if (reason.trim()) entry.reason = reason
  }

  entry.sceneNumber = script.scenes.find((scene) => scene.id === sceneId)?.number ?? entry.sceneNumber
  entry.changes = mergeChanges(entry.changes, incoming)

  if (!entry.changes.length) {
    script.sceneEdits = script.sceneEdits.filter((item) => item.id !== entry!.id)
    return false
  }
  return true
}

/** 详情页按时间倒序查看：最近更新在前。 */
export function editsForScene(script: Script, sceneId: string): SceneEditEntry[] {
  return script.sceneEdits
    .filter((entry) => entry.sceneId === sceneId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}
