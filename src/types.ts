export type RevisionColor = 'white' | 'blue' | 'pink' | 'yellow' | 'green' | 'goldenrod' | 'buff' | 'salmon' | 'cherry'
export type WarningStatus = 'pending' | 'accepted' | 'ignored'
export type WarningType = 'character' | 'prop' | 'wardrobe' | 'timeline'

export interface Character {
  id: string
  name: string
  actor: string
  introducedSceneId: string
  note: string
}

export interface Prop {
  id: string
  name: string
  introducedSceneId: string
  ownerId: string
  note: string
}

export interface Wardrobe {
  id: string
  characterId: string
  name: string
  timePeriods: string[]
  note: string
}

export interface Scene {
  id: string
  number: string
  slug: string
  synopsis: string
  intExt: 'INT' | 'EXT' | 'INT/EXT'
  location: string
  dayNight: string
  storyTime: string
  pageLength: number
  characterIds: string[]
  propIds: string[]
  costumes: Record<string, string>
  revision: RevisionColor
  status: 'draft' | 'review' | 'locked'
  reason: string
}

export type SceneEditField =
  | 'number'
  | 'slug'
  | 'synopsis'
  | 'intExt'
  | 'location'
  | 'dayNight'
  | 'storyTime'
  | 'pageLength'
  | 'revision'
  | 'status'
  | 'characterIds'
  | 'propIds'
  | 'costumes'
  | 'order'

export interface SceneEditChange {
  field: SceneEditField
  /** 多值字段下区分具体角色/道具/服装，例如角色 id。 */
  targetKey?: string
  before: string
  after: string
}

export interface SceneEditEntry {
  id: string
  sceneId: string
  /** 记录时刻的场号快照，场次删除后仍可辨认。 */
  sceneNumber: string
  createdAt: string
  updatedAt: string
  author: string
  reason: string
  open: boolean
  changes: SceneEditChange[]
}

export interface Script {
  title: string
  writer: string
  draft: string
  scenes: Scene[]
  characters: Character[]
  props: Prop[]
  wardrobes: Wardrobe[]
  sceneEdits: SceneEditEntry[]
}

export interface WarningItem {
  id: string
  type: WarningType
  severity: 'error' | 'warning'
  sceneId: string
  title: string
  detail: string
  suggestion: string
}

export interface Reply {
  id: string
  author: string
  text: string
  createdAt: string
}

export interface WarningReview {
  status: WarningStatus
  replies: Reply[]
}

export interface Version {
  id: string
  name: string
  createdAt: string
  script: Script
}

export interface ContinuityState {
  script: Script
  reviews: Record<string, WarningReview>
  versions: Version[]
  updatedAt: string
}

export interface DiffItem {
  id: string
  sceneNumber: string
  field: string
  before: string
  after: string
}
