import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { Character, ContinuityState, DiffItem, Prop, Reply, Scene, SceneEditChange, SceneEditEntry, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
export const EDIT_MERGE_MS = 2500
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export interface EditOptions {
  author?: string
  reason?: string
  coalesceKey?: string
}

interface PendingEdit {
  entry: SceneEditEntry
  coalesceKey?: string
  baseScript: Script
  timer: number
}

const sceneFieldLabels: Array<{ key: keyof Scene; label: string }> = [
  { key: 'number', label: '场号' },
  { key: 'slug', label: '场名' },
  { key: 'synopsis', label: '摘要' },
  { key: 'intExt', label: '内外景' },
  { key: 'location', label: '地点' },
  { key: 'dayNight', label: '日夜' },
  { key: 'storyTime', label: '故事时间' },
  { key: 'pageLength', label: '页数' },
  { key: 'revision', label: '修订色' },
  { key: 'status', label: '状态' },
  { key: 'reason', label: '修改理由' }
]
const sceneFieldLabel = new Map(sceneFieldLabels.map((item) => [item.key, item.label]))

interface NameLookups {
  characters: Map<string, string>
  props: Map<string, string>
  wardrobes: Map<string, string>
}

function buildLookups(script: Script): NameLookups {
  return {
    characters: new Map(script.characters.map((item) => [item.id, item.name])),
    props: new Map(script.props.map((item) => [item.id, item.name])),
    wardrobes: new Map(script.wardrobes.map((item) => [item.id, item.name]))
  }
}

const namesOf = (ids: string[], names: Map<string, string>) =>
  ids.map((itemId) => names.get(itemId) ?? itemId).join('、')
const costumesOf = (costumes: Record<string, string>, lookups: NameLookups) =>
  Object.entries(costumes)
    .map(([characterId, wardrobeId]) => `${lookups.characters.get(characterId) ?? characterId}：${lookups.wardrobes.get(wardrobeId) ?? wardrobeId}`)
    .join('、')

function pushChange(changes: SceneEditChange[], field: string, label: string, before: string, after: string) {
  if (before === after) return
  changes.push({ field, label, before, after })
}

/** Compare two scene versions and return every changed field as separate changes. */
function diffScene(beforeScene: Scene, after: Scene | undefined, lookups: NameLookups): SceneEditChange[] {
  if (!after) return [{ field: '__scene__', label: '场次', before: '已存在', after: '已删除' }]
  const changes: SceneEditChange[] = []
  sceneFieldLabels.forEach(({ key, label }) => {
    if (key === 'pageLength') {
      const beforeText = Number(beforeScene[key]).toFixed(2)
      const afterText = Number(after[key]).toFixed(2)
      pushChange(changes, key, label, beforeText, afterText)
    } else {
      pushChange(changes, key, label, String(beforeScene[key] ?? ''), String(after[key] ?? ''))
    }
  })
  pushChange(changes, 'characterIds', '出场角色', namesOf(beforeScene.characterIds, lookups.characters), namesOf(after.characterIds, lookups.characters))
  pushChange(changes, 'propIds', '出场道具', namesOf(beforeScene.propIds, lookups.props), namesOf(after.propIds, lookups.props))
  pushChange(changes, 'costumes', '服装', costumesOf(beforeScene.costumes, lookups), costumesOf(after.costumes, lookups))
  return changes
}

export interface SceneDiffGroup {
  sceneId: string
  sceneNumber: string
  changes: SceneEditChange[]
}

/** Compare two scripts and collect scene-level changes: fields, relations, wardrobe, order, add/delete. */
export function diffScenes(beforeScript: Script, afterScript: Script): SceneDiffGroup[] {
  const lookups = buildLookups(afterScript)
  const orderBefore = new Map(beforeScript.scenes.map((scene, index) => [scene.id, index]))
  const beforeById = new Map(beforeScript.scenes.map((scene) => [scene.id, scene]))
  const groups = new Map<string, SceneDiffGroup>()
  const groupFor = (sceneId: string, sceneNumber: string): SceneDiffGroup => {
    let group = groups.get(sceneId)
    if (!group) {
      group = { sceneId, sceneNumber, changes: [] }
      groups.set(sceneId, group)
    }
    return group
  }

  afterScript.scenes.forEach((scene, index) => {
    const beforeScene = beforeById.get(scene.id)
    const group = groupFor(scene.id, scene.number)
    if (!beforeScene) {
      group.changes.push({ field: '__scene__', label: '场次', before: '不存在', after: '新建场次' })
      return
    }
    diffScene(beforeScene, scene, lookups).forEach((change) => group.changes.push(change))
    const previousIndex = orderBefore.get(scene.id)
    if (previousIndex !== undefined && previousIndex !== index) {
      pushChange(group.changes, 'order', '顺序', `第 ${previousIndex + 1} 场`, `第 ${index + 1} 场`)
    }
  })

  beforeScript.scenes.forEach((scene) => {
    if (!afterScript.scenes.some((item) => item.id === scene.id)) {
      groupFor(scene.id, scene.number).changes.push({ field: '__scene__', label: '场次', before: '已存在', after: '已删除' })
    }
  })

  return [...groups.values()].filter((group) => group.changes.length > 0)
}

function normalizeState(parsed: Partial<ContinuityState>): ContinuityState | null {
  if (!parsed.script?.scenes?.length) return null
  return {
    script: { ...parsed.script, editLog: Array.isArray(parsed.script.editLog) ? parsed.script.editLog : [] } as Script,
    reviews: parsed.reviews ?? {},
    versions: (parsed.versions ?? []).map((version) => ({
      ...version,
      script: { ...version.script, editLog: Array.isArray(version.script.editLog) ? version.script.editLog : [] }
    })),
    updatedAt: parsed.updatedAt ?? new Date().toISOString()
  }
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const normalized = normalizeState(JSON.parse(raw) as Partial<ContinuityState>)
      if (normalized) return normalized
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], updatedAt: new Date().toISOString() }
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const sceneIndex = (sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  script.scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。'
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。'
        })
      }
    })

    if (index > 0 && script.scenes[index - 1].storyTime && scene.storyTime && index > 0) {
      const previous = script.scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string }> = [
    { key: 'slug', label: '场名' },
    { key: 'synopsis', label: '摘要' },
    { key: 'intExt', label: '内外景' },
    { key: 'location', label: '地点' },
    { key: 'dayNight', label: '日夜' },
    { key: 'storyTime', label: '故事时间' },
    { key: 'pageLength', label: '页数' },
    { key: 'revision', label: '修订色' },
    { key: 'status', label: '状态' },
    { key: 'reason', label: '修改理由' }
  ]
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [commitTick, setCommitTick] = useState(0)
  // Undo/redo stacks keep full states so edit records travel together with content.
  const undoRef = useRef<ContinuityState[]>([])
  const redoRef = useRef<ContinuityState[]>([])
  const stateRef = useRef(state)
  const pendingRef = useRef<PendingEdit | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  stateRef.current = state

  const applyState = useCallback((next: ContinuityState) => {
    // Keep the ref usable synchronously inside the same event (flush → mutate chaining);
    // render reassigns it to the committed state afterwards.
    stateRef.current = next
    setState(next)
  }, [])

  const clearPendingTimer = () => {
    if (pendingRef.current) window.clearTimeout(pendingRef.current.timer)
  }

  /** Flush the coalesced edit group into the log; call before undo/redo/snapshot/restore. */
  const flushPendingEdit = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    clearPendingTimer()
    pendingRef.current = null
    const groups = diffScenes(pending.baseScript, stateRef.current.script)
    if (!groups.length) return
    const now = new Date().toISOString()
    const entries: SceneEditEntry[] = groups.map((group, index) => ({
      id: index === 0 ? pending.entry.id : id('edit'),
      sceneId: group.sceneId,
      sceneNumber: group.sceneNumber,
      time: now,
      author: pending.entry.author,
      reason: pending.entry.reason,
      changes: group.changes
    }))
    applyState({ ...stateRef.current, script: { ...stateRef.current.script, editLog: [...entries, ...stateRef.current.script.editLog] } })
    setCommitTick((tick) => tick + 1)
  }, [applyState])

  const hasPendingEdit = useCallback(() => !!pendingRef.current, [])

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  useEffect(() => () => clearPendingTimer(), [])

  const pushUndo = useCallback((snapshot: ContinuityState) => {
    undoRef.current.push(snapshot)
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
  }, [])

  /**
   * Apply one script mutation. Scene-relevant changes are buffered into a single edit
   * group and coalesced while the same author keeps editing the same target quickly
   * (typing in a field fires one mutation per keystroke); a whole stream is one undo step.
   */
  const mutate = useCallback((mutator: (script: Script) => void, options: EditOptions = {}) => {
    const coalesceKey = options.coalesceKey
    const author = options.author?.trim() || stateRef.current.script.writer || '未署名'
    const reason = options.reason?.trim() || ''
    const pending = pendingRef.current
    const now = Date.now()
    const merges = !!pending && !!coalesceKey && pending.coalesceKey === coalesceKey &&
      pending.entry.author === author && now - new Date(pending.entry.time).getTime() <= EDIT_MERGE_MS

    if (!merges) flushPendingEdit()
    const baseline = stateRef.current
    const next: ContinuityState = { ...baseline, script: clone(baseline.script), updatedAt: new Date().toISOString() }
    mutator(next.script)
    const groups = diffScenes(baseline.script, next.script)
    applyState(next)
    if (!merges) pushUndo(baseline)
    if (!groups.length) return

    if (merges && pending) {
      // Same editing stream: keep original base and timestamp, but refresh author/reason
      // so a reason typed after the first keystroke still lands on this entry. The entry
      // is recomputed from the stream's base when it finally flushes.
      pending.entry.author = author
      pending.entry.reason = reason
      window.clearTimeout(pending.timer)
      pending.timer = window.setTimeout(() => flushPendingEdit(), EDIT_MERGE_MS)
    } else {
      const created: PendingEdit = {
        entry: { id: id('edit'), sceneId: '', sceneNumber: '', time: new Date(now).toISOString(), author, reason, changes: [] },
        coalesceKey,
        baseScript: clone(baseline.script),
        timer: 0
      }
      created.timer = window.setTimeout(() => flushPendingEdit(), EDIT_MERGE_MS)
      pendingRef.current = created
    }
  }, [applyState, flushPendingEdit, pushUndo])

  const undo = useCallback(() => {
    flushPendingEdit()
    const target = undoRef.current.pop()
    if (!target) return
    redoRef.current.push(stateRef.current)
    applyState(target)
  }, [applyState, flushPendingEdit])

  const redo = useCallback(() => {
    flushPendingEdit()
    const target = redoRef.current.pop()
    if (!target) return
    undoRef.current.push(stateRef.current)
    applyState(target)
  }, [applyState, flushPendingEdit])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    const baseline = stateRef.current
    if (baseline.script[field] === value) return
    const next: ContinuityState = { ...baseline, script: { ...baseline.script, [field]: value }, updatedAt: new Date().toISOString() }
    pushUndo(baseline)
    applyState(next)
  }, [applyState, pushUndo])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene], options?: EditOptions) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    }, { coalesceKey: `scene:${sceneId}:${String(field)}`, ...options })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string, options?: EditOptions) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    }, { coalesceKey: `scene:${sceneId}:${field}`, ...options })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string, options?: EditOptions) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    }, { coalesceKey: `scene:${sceneId}:costume:${characterId}`, ...options })
  }, [mutate])

  const moveScene = useCallback((sceneId: string, direction: -1 | 1, options?: EditOptions) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    }, { coalesceKey: `scene:${sceneId}:move`, ...options })
  }, [mutate])

  const addScene = useCallback((options?: EditOptions) => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
    }, { coalesceKey: `scene:${sceneId}:create`, ...options })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string, options?: EditOptions) => {
    if (stateRef.current.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) }, options)
  }, [mutate])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    }, { coalesceKey: `character:${characterId}:${String(field)}` })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    }, { coalesceKey: `prop:${propId}:${String(field)}` })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    }, { coalesceKey: `wardrobe:${wardrobeId}:${String(field)}` })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: { ...(previous.reviews[warningId] ?? { replies: [] }), status }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    flushPendingEdit()
    const current = stateRef.current
    const version: Version = { id: id('version'), name: name.trim() || `版本 ${current.versions.length + 1}`, createdAt: new Date().toISOString(), script: clone(current.script) }
    applyState({ ...current, versions: [version, ...current.versions] })
    return version
  }, [applyState, flushPendingEdit])

  const restoreVersion = useCallback((versionId: string) => {
    flushPendingEdit()
    const current = stateRef.current
    const version = current.versions.find((item) => item.id === versionId)
    if (!version) return
    // Restoring replaces the script (including its edit log) with the frozen snapshot,
    // so only records that existed in that version remain visible. Undo brings both back.
    const next: ContinuityState = { ...current, script: clone(version.script), updatedAt: new Date().toISOString() }
    pushUndo(current)
    applyState(next)
  }, [applyState, flushPendingEdit, pushUndo])

  const reset = useCallback(() => {
    flushPendingEdit()
    const baseline = stateRef.current
    const next: ContinuityState = { script: clone(sampleScript), reviews: {}, versions: baseline.versions, updatedAt: new Date().toISOString() }
    pushUndo(baseline)
    applyState(next)
  }, [applyState, flushPendingEdit, pushUndo])

  return {
    state,
    saveStatus,
    commitTick,
    hasPendingEdit,
    warnings: deriveWarnings(state.script),
    flushPendingEdit,
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    setReviewStatus,
    addReply,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}
