/**
 * 平台发布配置 Schema
 *
 * 声明式描述每个平台的可配置字段。UI 据此自动渲染表单，
 * 无需为每个平台手写 React 组件。每个 SchemaField 的 key 对应
 * PublishParams 的字段名，由适配器在 buildPayload 中翻译为
 * 平台原生字段名。
 */

/** 字段通用属性 */
export interface FieldBase {
  /** 字段键名，对应 PublishParams 的字段名 */
  key: string
  /** UI 显示标签 */
  label: string
  /** 字段说明（tooltip） */
  help?: string
  /** 是否必填 */
  required?: boolean
  /** 是否仅直发模式下出现（草稿模式收起） */
  publishOnly?: boolean
  /** 选择模式：single=单选 / multi=多选 / either-or=二选一（配合 eitherWith） */
  selectMode?: 'single' | 'multi' | 'either-or'
  /** 互斥字段 key（selectMode='either-or' 时，选了本字段清另一个） */
  eitherWith?: string
  /** 远程引用声明（resolveReferences 据此拉列表，UI 渲染 Select） */
  remoteRef?: {
    /** 平台 API 路径（如 /blog/phoenix/console/v1/write-active/list） */
    apiPath: string
    /** 查询参数（如 { type: '1' }） */
    params?: Record<string, string>
  }
}

/** 选项来源 */
export type RefSource = 'remote' | 'static'

/** 选项值 */
export interface FieldOption {
  value: string
  label: string
}

/** 标签字段：自由输入 + 建议词（来自 resolveReferences） */
export interface TagsField extends FieldBase {
  kind: 'tags'
  key: 'tags'
  /** 最大标签数 */
  max?: number
  /** 建议词来源 key（resolveReferences 的 refs[suggestionsKey]） */
  suggestionsKey?: string
}

/** 分类字段：远程拉取 或 静态选项 */
export interface CategoryField extends FieldBase {
  kind: 'category'
  key: 'category'
  source: RefSource
  /** source=remote 时，从 refs[refKey ?? 'categories'] 取 */
  refKey?: string
  /** source=static 时的静态选项 */
  options?: FieldOption[]
}

/** 专栏/合集字段 */
export interface ColumnField extends FieldBase {
  kind: 'column'
  key: 'column'
  source: RefSource
  refKey?: string
  options?: FieldOption[]
  /** 最大选择数（selectMode='multi' 时） */
  max?: number
}

/** 封面字段 */
export interface CoverField extends FieldBase {
  kind: 'cover'
  key: 'cover'
  modes: Array<'auto' | 'manual' | 'none'>
}

/** 可见性字段 */
export interface VisibilityField extends FieldBase {
  kind: 'visibility'
  key: 'visibility'
  options: FieldOption[]
}

/** 原创类型字段 */
export interface OriginalTypeField extends FieldBase {
  kind: 'originalType'
  key: 'originalType'
  options: Array<{ value: 'original' | 'reprint' | 'translate'; label: string }>
  /** 转载/翻译时联动 originalLink */
  needsOriginalLink?: boolean
}

/** 活动字段（远程拉取） */
export interface ActivityField extends FieldBase {
  kind: 'activity'
  key: 'activityId'
  source: 'remote'
  refKey?: string
}

/** 话题字段 */
export interface TopicField extends FieldBase {
  kind: 'topic'
  key: 'topicId'
  source: RefSource
  refKey?: string
  options?: FieldOption[]
}

/** 节点/分区/板块字段（社区型必填） */
export interface NodeField extends FieldBase {
  kind: 'node'
  key: 'node'
  source: RefSource
  refKey?: string
  options?: FieldOption[]
}

/** 定时发布字段 */
export interface ScheduleField extends FieldBase {
  kind: 'schedule'
  key: 'scheduleAt'
  enabled: boolean
}

/** 评论开关字段 */
export interface CommentsField extends FieldBase {
  kind: 'comments'
  key: 'commentsEnabled'
}

/** 赞赏开关字段 */
export interface RewardField extends FieldBase {
  kind: 'reward'
  key: 'reward'
}

/** 付费阅读字段 */
export interface PaidField extends FieldBase {
  kind: 'paid'
  key: 'paid'
}

/** 副标题字段 */
export interface SubtitleField extends FieldBase {
  kind: 'subtitle'
  key: 'subtitle'
  maxLength?: number
}

/** 摘要字段 */
export interface SummaryField extends FieldBase {
  kind: 'summary'
  key: 'summary'
  maxLength?: number
}

/** 平台特有开关（兜底，避免每加字段都改类型） */
export interface ToggleField extends FieldBase {
  kind: 'toggle'
  key: string
}

/** 平台特有文本 */
export interface TextField extends FieldBase {
  kind: 'text'
  key: string
  placeholder?: string
  multiline?: boolean
  maxLength?: number
}

/** 平台特有下拉 */
export interface SelectField extends FieldBase {
  kind: 'select'
  key: string
  options: FieldOption[]
}

/** 所有字段类型联合 */
export type SchemaField =
  | TagsField | CategoryField | ColumnField | CoverField
  | VisibilityField | OriginalTypeField | ActivityField | TopicField | NodeField
  | ScheduleField | CommentsField | RewardField | PaidField
  | SubtitleField | SummaryField
  | ToggleField | TextField | SelectField

/** 字段分组（UI 折叠展示，默认只展开「常用」组） */
export interface SchemaGroup {
  title: string
  /** field key 列表 */
  fields: string[]
  defaultOpen?: boolean
}

/** 平台发布 Schema */
export interface PublishSchema {
  fields: SchemaField[]
  groups?: SchemaGroup[]
  /** 不支持的模式（UI 据此禁用直发/定时开关） */
  unsupportedModes?: Array<'publish' | 'schedule'>
}
