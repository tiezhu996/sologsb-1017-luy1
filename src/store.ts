import { useCallback, useEffect, useRef, useState } from 'react'
import { sampleScript } from './sample'
import { applySceneChanges, closeOpenEdits, closeSceneEdits, diffScene } from './history'
import type { Character, ContinuityState, DiffItem, Prop, Scene, Script, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const touch = () => new Date().toISOString()

function normalizeScript(raw: Partial<Script> | undefined): Script {
  const script = raw as Script
  if (!Array.isArray(script.sceneEdits)) script.sceneEdits = []
  return script
}

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) {
        normalizeScript(parsed.script)
        parsed.versions?.forEach((version) => normalizeScript(version.script))
        return parsed
      }
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], updatedAt: touch() }
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
  const stateRef = useRef(state)
  const undoRef = useRef<Script[]>([])
  const redoRef = useRef<Script[]>([])
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  /** 进入撤销栈的修改：基于 ref 同步计算，避免开发环境 StrictMode 双调用污染历史。 */
  const commit = useCallback((updater: (previous: ContinuityState) => ContinuityState) => {
    const previous = stateRef.current
    const next = updater(previous)
    if (next === previous) return
    undoRef.current.push(clone(previous.script))
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
    stateRef.current = next
    setState(next)
  }, [])

  /** 不进撤销栈的修改（编辑原因、记录归档等），靠整稿快照与撤销重做保持同步。 */
  const patch = useCallback((updater: (previous: ContinuityState) => ContinuityState) => {
    const previous = stateRef.current
    const next = updater(previous)
    if (next === previous) return
    stateRef.current = next
    setState(next)
  }, [])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    commit((previous) => {
      const script = clone(previous.script)
      mutator(script)
      return { ...previous, script, updatedAt: touch() }
    })
  }, [commit])

  const undo = useCallback(() => {
    const previous = stateRef.current
    const target = undoRef.current.pop()
    if (!target) return
    redoRef.current.push(clone(previous.script))
    const next = { ...previous, script: target, updatedAt: touch() }
    stateRef.current = next
    setState(next)
  }, [])

  const redo = useCallback(() => {
    const previous = stateRef.current
    const target = redoRef.current.pop()
    if (!target) return
    undoRef.current.push(clone(previous.script))
    const next = { ...previous, script: target, updatedAt: touch() }
    stateRef.current = next
    setState(next)
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  /** 场次字段改动：对比改前改后写入同一条编辑记录，值没变不进撤销栈。 */
  const commitScene = useCallback((sceneId: string, reason: string, mutator: (script: Script) => void) => {
    commit((previous) => {
      const beforeScene = previous.script.scenes.find((scene) => scene.id === sceneId)
      if (!beforeScene) return previous
      const script = clone(previous.script)
      mutator(script)
      const afterScene = script.scenes.find((scene) => scene.id === sceneId)
      if (!afterScene) return previous
      const changes = diffScene(beforeScene, afterScene, script)
      if (!changes.length) return previous
      if (!applySceneChanges(script, sceneId, changes, reason, script.writer)) return previous
      return { ...previous, script, updatedAt: touch() }
    })
  }, [commit])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene], reason = '') => {
    commitScene(sceneId, reason, (script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [commitScene])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string, reason = '') => {
    commitScene(sceneId, reason, (script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [commitScene])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string, reason = '') => {
    commitScene(sceneId, reason, (script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [commitScene])

  const moveScene = useCallback((sceneId: string, direction: -1 | 1, reason = '') => {
    commit((previous) => {
      const index = previous.script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= previous.script.scenes.length) return previous
      const script = clone(previous.script)
      const [moved] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, moved)
      applySceneChanges(
        script,
        sceneId,
        [{ field: 'order', before: `第 ${index + 1} 位`, after: `第 ${target + 1} 位` }],
        reason,
        script.writer
      )
      return { ...previous, script, updatedAt: touch() }
    })
  }, [commit])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    commit((previous) => {
      if (previous.script.scenes.length <= 1) return previous
      const script = clone(previous.script)
      script.scenes = script.scenes.filter((scene) => scene.id !== sceneId)
      // 未完成的一轮随场次删除一并丢弃；已归档记录保留在剧本数据中。
      script.sceneEdits = script.sceneEdits.filter((entry) => !(entry.open && entry.sceneId === sceneId))
      return { ...previous, script, updatedAt: touch() }
    })
  }, [commit])

  /** 正在填写的本轮原因：只更新打开中的记录，不进撤销栈。 */
  const setEditReason = useCallback((sceneId: string, reason: string) => {
    patch((previous) => {
      if (!previous.script.sceneEdits.some((entry) => entry.open && entry.sceneId === sceneId)) return previous
      const script = clone(previous.script)
      const entry = script.sceneEdits.find((item) => item.open && item.sceneId === sceneId)
      if (entry) entry.reason = reason
      return { ...previous, script }
    })
  }, [patch])

  /** 完成本场本轮修改：归档记录并把原因同步到场次“修改理由”。 */
  const finalizeSceneEdit = useCallback((sceneId: string) => {
    patch((previous) => {
      if (!previous.script.sceneEdits.some((entry) => entry.open && entry.sceneId === sceneId)) return previous
      const script = clone(previous.script)
      closeSceneEdits(script, sceneId)
      return { ...previous, script, updatedAt: touch() }
    })
  }, [patch])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
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
    })
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
    })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: { ...(previous.reviews[warningId] ?? { replies: [] }), status }
      },
      updatedAt: touch()
    }))
  }, [])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply = { id: id('reply'), author, text: text.trim(), createdAt: touch() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      },
      updatedAt: touch()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    const previous = stateRef.current
    // 快照先归档未完成记录，使保存下来的版本只含已经成形的编辑历史。
    const script = clone(previous.script)
    closeOpenEdits(script)
    const version: Version = {
      id: id('version'),
      name: name.trim() || `版本 ${previous.versions.length + 1}`,
      createdAt: touch(),
      script
    }
    const next = { ...previous, script, versions: [version, ...previous.versions] }
    stateRef.current = next
    setState(next)
    return version
  }, [])

  const restoreVersion = useCallback((versionId: string) => {
    commit((previous) => {
      const version = previous.versions.find((item) => item.id === versionId)
      if (!version) return previous
      // 整稿（连同该版本自带的编辑记录）换回；恢复后只看得到那版已有的记录。
      const script = normalizeScript(clone(version.script))
      return { ...previous, script, updatedAt: touch() }
    })
  }, [commit])

  const reset = useCallback(() => {
    commit((previous) => ({ ...previous, script: clone(sampleScript), reviews: {}, updatedAt: touch() }))
  }, [commit])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    setEditReason,
    finalizeSceneEdit,
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
