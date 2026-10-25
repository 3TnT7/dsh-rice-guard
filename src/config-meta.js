import { DEFAULTS } from './config.js'

export const CONFIG_GROUPS = Object.freeze([
  { id: 'truncation', label: '工具定义精简', summary: '控制发给模型的工具定义如何压缩，可能影响前缀缓存。' },
  { id: 'visibility', label: '工具消隐', summary: '按名单从模型可见工具中隐藏指定工具。' },
  { id: 'ordering', label: '键排序', summary: '稳定工具参数对象的键顺序，减少无意义变动。' },
  { id: 'freeze', label: '会话冻结', summary: '决定投影类设置是否在会话开始时固定。' },
  { id: 'storage', label: '本地存档', summary: '控制统计与精调存档的落盘和自动备份。' },
  { id: 'pricing', label: '价格估算', summary: '选择面板成本估算所用价表，不影响请求。' },
  { id: 'debug', label: '日志', summary: '控制诊断日志级别、去重与数量上限。' },
].map((item) => Object.freeze(item)))

const definitions = [
  // path, kind, label, summary, impact, recommended, risk, timing, extras
  ['truncation.enabled','boolean','启用工具定义精简','是否压缩命中工具的说明和参数定义。','开启会缩短发送给模型的工具定义、节省上下文；代价是细节可能被删，关闭则保留原文。','开启；遇到工具参数理解异常时可关闭。','medium','new-session'],
  ['truncation.shadowPrefixes','stringList','处理工具前缀','只处理名称以这些前缀开头的工具。','开启精简时匹配这些前缀的工具会被处理；空列表代表全部工具，可能误伤核心工具并改变前缀缓存。','保留默认 mcp__；不要设为空，除非确认要处理全部工具。','high','new-session',{maxEntries:256,placeholder:'例如 mcp__'}],
  ['truncation.keepFull','stringList','完整保留名单','名单中的工具即使命中前缀也不精简。','名单匹配优先于精简；增加项目会保住完整定义但增加上下文占用，减少项目则可能让工具定义被压缩。','把依赖完整参数说明的工具名加入；最多 256 项。','medium','new-session',{maxEntries:256,placeholder:'精确工具名'}],
  ['truncation.minSchemaChars','number','最小参数长度','短于此字符数的参数定义不做精简。','调高会让更多小型定义保持原样、保真但省 token 较少；调低则扩大精简范围。','700–800 字符。','low','new-session',{unit:'字符',min:0,max:1000000,step:1}],
  ['truncation.maxSchemaChars','number','参数目标上限','精简后参数定义的目标字符上限。','调低更省上下文但更容易丢参数细节；调高较保真但节省较少，定义变化会影响前缀缓存。','800 字符。','medium','new-session',{unit:'字符',min:200,max:1000000,step:1}],
  ['truncation.maxDepth','number','参数保留层级','参数对象最多保留的嵌套层级。','调低压缩更强但深层参数可能坍缩；调高保留结构但占用更多上下文。','3 层。','medium','new-session',{unit:'层',min:0,max:6,step:1}],
  ['truncation.topDescriptionChars','number','顶层说明上限','限制参数顶层说明的字符数。','调低更省上下文但说明更易被截断；调高更完整但节省较少。','140 字符。','low','new-session',{unit:'字符',min:0,max:4000,step:1}],
  ['truncation.nestedDescriptionChars','number','嵌套说明上限','限制嵌套参数说明的字符数。','调低更省上下文但子参数说明更易丢失；调高更保真但占用增加。','60 字符。','low','new-session',{unit:'字符',min:0,max:4000,step:1}],
  ['truncation.descriptionDepth','number','说明保留深度','超过此层级的参数说明会被丢弃。','调低可进一步压缩但更深层提示会消失；调高保留更多说明、节省较少。','1 层。','medium','new-session',{unit:'层',min:0,max:6,step:1}],
  ['truncation.maxDescriptionChars','number','工具说明上限','限制投影中工具整体说明的字符数。','调低更省上下文但工具用途说明可能不完整；调高更易理解但节省较少。','260 字符；0 表示关闭此项截断。','low','new-session',{unit:'字符',min:0,max:8000,step:1}],
  ['truncation.maxBranches','number','联合分支上限','启用联合类型截断时最多保留的分支数。','仅 truncateUnions 开启时生效；调低可能删掉有效参数形态，调高则保留更多内容。','4 个；仅在明确需要时开启联合分支截断。','high','new-session',{unit:'个',min:1,max:64,step:1}],
  ['truncation.truncateUnions','boolean','截断联合类型','是否截短 oneOf、anyOf、allOf 的分支。','开启可进一步缩短定义，但模型可能看不到可用参数分支；关闭保留全部分支、占用略多。','关闭，避免遗漏有效参数形式。','high','new-session'],
  ['truncation.dropAnnotations','boolean','删除编辑注解','是否丢弃 examples、title、$comment 等注解。','开启会移除编辑期注解以节省上下文，代价是模型也看不到这些示例和提示；关闭则保留。','开启；若注解对工具使用有帮助再关闭。','medium','new-session'],
  ['truncation.dryRun','boolean','精简试运行','只计算精简结果但不替换原始工具定义。','开启可观察统计而不改变模型看到的定义；仍会计算，不能节省上下文。','排查效果时开启，确认后关闭以实际精简。','low','new-session'],
  ['visibility.enabled','boolean','启用工具消隐','是否按精确名单或前缀隐藏工具。','开启后命中名单的工具不再展示给模型，可能阻断其调用；关闭时名单仍保存但不起作用。','默认关闭；确认工具不应被模型调用时再开启。','high','new-session'],
  ['visibility.dryRun','boolean','消隐试运行','只统计命中项而不隐藏工具。','开启只观察命中情况、不改变模型可见工具；因此不会减少上下文。','配置名单时先开启核对，确认后关闭。','low','new-session'],
  ['visibility.exact','stringList','精确隐藏名单','按完整工具名匹配要隐藏的工具。','启用消隐后，名单中的工具会隐藏；改错名称只会空转，列错名称则可能让模型失去工具。','只列出确认不应提供给模型的准确名称。','high','new-session',{maxEntries:256,placeholder:'精确工具名'}],
  ['visibility.prefixes','stringList','隐藏名称前缀','隐藏名称以这些前缀开头的工具。','启用消隐后匹配前缀的工具会隐藏；空列表表示不按前缀消隐，与精简前缀列表语义相反。','默认空列表；仅填写范围明确的前缀。','high','new-session',{maxEntries:256,placeholder:'例如 mcp__server__'}],
  ['ordering.enabled','boolean','启用键排序','是否对工具参数对象递归排序键。','开启可让键顺序稳定、减少无意义差异；会增加少量处理且可能影响前缀缓存，关闭则保留原顺序。','开启。','low','new-session'],
  ['ordering.maxDepth','number','排序递归深度','键排序最多递归的层级，超出部分原样返回。','调高可排序更深对象但处理更多；调低更快但深层键顺序可能不稳定。','64 层。','low','new-session',{unit:'层',min:0,max:512,step:1}],
  ['ordering.verify','enum','排序校验方式','选择是否检查排序前后的长度一致。','length 会做长度自检并在异常时保护原值；none 少一次校验但失去这层防护。','length。','medium','new-session',{options:['length','none']}],
  ['ordering.circuitBreaker','number','排序熔断阈值','连续失败多少次后停用本进程的排序。','调低会更早停止排序以避免反复失败；调高更能容忍偶发错误；小于等于 0 会关闭熔断。','5 次；不要关闭，除非正在排查。','medium','new-session',{unit:'次',min:0,max:1000,step:1}],
  ['freeze.enabled','boolean','冻结会话配置','是否让投影和冻结行为类设置在新会话开始时生效。','开启可避免会话中途改变投影、击穿前缀缓存；代价是相关改动要等新会话。关闭此项会立即对所有会话生效。','开启。','medium','immediate'],
  ['storage.enabled','boolean','启用本地存档','是否持续写入统计 JSONL 与自动备份。','关闭后停止新增统计 JSONL 与自动备份，但已有存档仍会加载；关闭这一次保存本身仍写入存档，否则重启会自动重新开启。','开启；若停用，请确认不再需要新增统计和备份。','medium','immediate'],
  ['storage.maxBackups','number','自动备份份数','精调自动备份最多保留的份数。','调高可留更多历史版本但占用更多磁盘；设为 0 则完全不备份，误改后更难恢复。','20 份；建议至少保留 5 份。','medium','immediate',{unit:'份',min:0,max:100,step:1}],
  ['pricing.model','string','估算模型','选择成本估算使用的模型价表。','切换后只改变面板估算金额，不改变任何请求；旧模型名可能被归并到现行型号。','deepseek-flash；选实际使用的模型。','low','display-only',{placeholder:'模型名称（最多 120 字符）'}],
  ['pricing.period','enum','默认计价时段','选择面板默认显示的高峰或非高峰价。','切换只改变面板估算价，不自动判断时段，也不影响请求。','off-peak；按需要切换 peak。','low','display-only',{options:['off-peak','peak']}],
  ['pricing.override','object','自定义单价','可选地覆盖输入命中、输入未命中和输出单价。','填写后按元/百万 token 使用自定义价格；任何一项无效会使整组覆盖失效并回到官方价表，价格只影响展示。','null 使用官方价；自定义时填写 hit、miss、out 三个非负数。','medium','display-only',{unit:'元/百万 token'}],
  ['debug.logLevel','enum','日志级别','选择记录 warn、info 或不记录普通日志。','warn 记录警告，info 增加信息日志，silent 关闭这些日志；越详细越便于排查但日志更多。','warn。','low','immediate',{options:['silent','warn','info']}],
  ['debug.logOnce','boolean','相同日志只记一次','是否对同一原因和工具名的日志去重。','开启可避免重复日志刷屏但会隐藏后续重复发生；关闭便于观察频率、日志量会增加。','开启。','low','immediate'],
  ['debug.maxLoggedTools','number','工具日志上限','限制去重后的工具级日志条数。','调高能保留更多工具诊断但日志更多；调低减少噪声，也可能漏掉后续工具线索。','20 条。','low','immediate',{unit:'条',min:0,max:1000,step:1}],
]

export const CONFIG_META = Object.freeze(definitions.map(([path, kind, label, summary, impact, recommended, risk, timing, extras = {}]) => {
  const [group, key] = path.split('.')
  return Object.freeze({ path, group, kind, label, summary, impact, default: DEFAULTS[group][key], recommended, risk, timing, editable: true, ...extras })
}))

export const META_BY_PATH = Object.freeze(Object.fromEntries(CONFIG_META.map((entry) => [entry.path, entry])))

/** Return leaf paths and values in UI group order; hostile values never escape as errors. */
export function flattenLeaves(config) {
  try {
    const rows = []
    for (const { id } of CONFIG_GROUPS) {
      const group = config != null && typeof config === 'object' ? config[id] : undefined
      if (group === null || typeof group !== 'object') continue
      for (const entry of CONFIG_META) {
        if (entry.group === id && Object.prototype.hasOwnProperty.call(group, entry.path.slice(id.length + 1))) {
          rows.push({ path: entry.path, value: group[entry.path.slice(id.length + 1)] })
        }
      }
    }
    return rows
  } catch {
    return []
  }
}
