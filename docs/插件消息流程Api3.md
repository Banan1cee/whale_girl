# Api 3 消息流程插件

本地开发版新增消息插件。公开上架需要市场同时提供 index-v3.json 和 Api 3 校验。市场投稿目标仍为 Banan1cee/whale-girl-plugins 的 main。

## 安装和授权

ZIP 根目录放 plugin.json 和 plugin.wasm。清单 Api 填 3，Kind 填 message，Hooks 声明需要的扩展点，Permissions 声明附加权限。MinAppVersion 填 4.1.0。其他名称、作者、版本及描述字段沿用原规则。

用户在卡片启用时确认持续读取当前消息和上一条机器人回复，停用即撤销。配置都在卡片的「设置」，当前版本使用作者提供的 JSON 配置。更新消息插件后需要重新启用，配置保留。

## 扩展点

| Hooks 条目 | 执行时机 | 允许输出 |
| --- | --- | --- |
| chat.received | 通过宿主基础检查后，普通消息进行触发判定前 | state |
| chat.pre_reply | 回复触发判定 | action、state |
| chat.prompt | 宿主组装模型输入后 | system、state |
| chat.generate | 模型生成前 | text、state |
| chat.reply | 普通回复生成后 | text、state |
| chat.before_send | 回复最终清洗、拆分及记忆落盘前 | text、state |
| chat.dispatched | 网关交出回复后 | state |

action 可填 wake、skip、pass。wake 请求接话，skip 跳过本条，pass 保留其他插件或宿主判定。按插件 ID 排序执行，第一个明确判定生效。宿主命令权限、静默和发送限制仍由宿主执行。命令回复不经过普通回复修改接口。

chat.generate 返回 text 时替换本轮默认生成，省去原模型调用。返回空文本会结束本轮。chat.prompt 返回 system 时替换系统提示词，需要 model.prompt 权限，默认模型、预算与计费仍由宿主管理。chat.reply 和 chat.before_send 的 text 可以包含宿主支持的表情包分类标记。

chat.dispatched 的 delivery 是网关提交结果。local=true 表示交给本地桥接，dryRun=true 表示由宿主模拟或本地接管，均不能据此认定微信已送达。

## 输入和状态

run() 返回 0，通过 whale.input_size()、whale.input_byte(i) 读取 UTF-8 JSON，通过 whale.output_byte(i) 写出 UTF-8 JSON。消息插件沿用 Api 2 的字节接口。

输入包含 api、hook、message、now、lastBot、state、settings，以及当前环节的 text、system 或 delivery。message 包含会话标识、群私聊类型、发言人、正文和提及信息。lastBot 包含最近一条已生成回复的正文、时间和目标发言人。旧数据可能缺少 targetId，插件应返回 pass。

声明 chat.history 后可读取最近 12 条会话消息。声明 model.prompt 后可读取和替换系统提示词。宿主不会把完整配置或模型密钥传给插件。

state 是插件自行定义的 JSON 对象，最多 16 KiB，每次输出完整替换。宿主按插件和会话隔离持久保存，因此小助手的剩余轮数、最后接话人、窗口截止时间和插话中断标记都可由插件自己维护。状态只影响该插件，不写进鲸鲸原有记忆对象。

## 性能和故障

单插件每次最多 300 毫秒，每个扩展点总预算 800 毫秒，最多同时登记 8 个消息插件。输入输出最多 64 KiB。超时杀掉隔离进程，异常、非法输出或落盘失败均回退原行为，该插件暂停调用 30 秒。执行中停用、更新或修改设置会丢弃旧执行结果。

目前没有开放定时器、任意文件访问、直接联网、自定义模型服务调用和跨会话主动发送。语音输出仍由宿主已有语音策略决定。上述能力需要继续实现具体的授权及宿主接口，不能通过声明不存在的权限获得。
