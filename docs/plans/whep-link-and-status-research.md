# WHEP 的 Link 头与 HTTP 状态码：规范出处与分层结论

> 范围：RFC 8288 / RFC 9110 / RFC 9725 / WHEP Internet-Draft / W3C WebRTC REC / Chromium 源码。
> 目的：把「Link 头中 ICE 服务器的解析容错」和「WHEP 各方法状态码的判定」从二手描述拉回可核对的一手文本，并区分三类结论：
>
> - **【强制】** 规范用 MUST / MUST NOT / REQUIRED / SHALL 规定的行为。
> - **【允许】** 规范用 MAY / OPTIONAL / COULD，或规范未禁止的实现自由度。
> - **【惯例】** 规范没有要求，由实现或部署自行决定的实践（含浏览器实现与线上现状）。
>
> 引用约定：只引用可公开访问的链接。行号随上游漂移，**结论以章节号与原文引述为准**，链接仅作定位。

## 0. 版本基线

| 文档 | 本次核对的版本 | 说明 |
| --- | --- | --- |
| RFC 8288 | 2017-10，Standards Track | Web Linking |
| RFC 9110 | 2022-06，Standards Track | HTTP Semantics |
| RFC 9725 | WHIP | 注册 `ice-server` 关系类型，WHEP 直接复用 |
| WHEP I-D | `draft-ietf-wish-whep-05`，2026-10-11 | 与 -04 的 ICE 配置与状态码条款一致 |
| W3C WebRTC | REC（https://www.w3.org/TR/webrtc/） | `RTCIceServer`、`RTCConfiguration.iceServers` |
| Chromium | `refs/heads/main` 的 `rtc_peer_connection.cc` | 构造函数中的 `iceServers` 转换 |

WHEP 至今仍是 Internet-Draft，**不是 RFC**。对 WHEP 的一切「强制 / 允许」都是"草案规定"，效力弱于 RFC 8288 / RFC 9110 本身。

---

# 第一部分：Link 头、`rel` 参数与 ICE 服务器

## 1.1 RFC 8288 的字段语法与解析义务

**语法（§3，【强制】）**

```
Link       = #link-value
link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )
link-param = token BWS [ "=" BWS ( token / quoted-string ) ]
```

原文（§3）："Note that any link-param can be generated with values using either the token or the quoted-string syntax; therefore, **recipients MUST be able to parse both forms**." 即 `x=y` 与 `x="y"` 必须等价，解析器不能只认带引号的形式。

链接目标是 `<>` 内的 URI-Reference；相对引用**必须**按 RFC 3986 §5 解析（§3.1），且 "any base IRI appearing in the message's content is not applied"。

来源：[RFC 8288 §3](https://www.rfc-editor.org/rfc/rfc8288.html#section-3)

## 1.2 `rel` 参数

**§3.3【强制】**："The rel parameter **MUST be present** but **MUST NOT appear more than once** in a given link-value; **occurrences after the first MUST be ignored by parsers**."

- 缺少 `rel` 的 link-value 没有关系类型，对 ICE 发现必须跳过。
- `rel` 重复时取第一个、其余忽略；**不是**整条丢弃，也不是拼接。
- `rel` 可携带多个空格分隔的关系类型：`relation-type *( 1*SP relation-type )`。此时 "establishes multiple links that share the same context, target, and target attributes"，所以 `rel="ice-server alternate"` 仍应作为 ice-server 链接处理。

**比较规则（【强制】）**

- 注册关系类型（§2.1.1）："MUST be compared character by character in a **case-insensitive** fashion"。
- 扩展关系类型（URI，§2.1.2）："MUST be compared as strings ... (after converting to URIs ...) in a case-insensitive fashion"。

推论：`rel="ICE-Server"` 与 `rel="ice-server"` 等价；`urn:ietf:params:whep:ext:...` 也不能因大小写不同被当成另一个关系。

**未知关系类型（通用层面【惯例】）**

RFC 8288 抽象层把语义交给应用："links are used by link applications. Generally, an application will define the link relation type(s) it uses"。RFC 8288 唯一的显式"整条忽略"规则在 §3.2 的 `anchor`（"the entire link is to be ignored; link applications MUST NOT process the link without applying the anchor"），**不适用于**未知 `rel`。

所以"忽略不认识的 `rel`"在通用层面是【惯例】；**在 WHEP 里是【强制】**，见 §1.5。

## 1.3 无效 / 无法识别的 link-value

RFC 8288 **没有**定义"某条 link-value 语法错误时，同字段其他链接如何处理"。可引用的两条依据：

1. **§1.2【强制】**："The requirements regarding conformance and error handling highlighted in [RFC7230], Section 2.5 apply to this document." —— 继承 HTTP 字段解析的健壮性原则（现由 RFC 9110 承接）。
2. **§3 的列表语法（【强制】）**：`#link-value` 使用列表扩展；RFC 9110 §5.6.1 规定接收方必须能解析空列表元素，且 "a recipient MUST ignore empty list elements"。

由此得到**按条容错**的依据：

| 情形 | 依据 | 分类 |
| --- | --- | --- |
| 字段值含空列表元素（如 `Link: ,`） | RFC 9110 §5.6.1：MUST 解析并忽略空元素 | 【强制】 |
| 单条缺 `rel` | RFC 8288 §3.3（rel MUST be present） | 【强制】跳过该条 |
| 单条目标不是合法 URI-Reference | RFC 8288 §3.1 要求目标是 URI-Reference | 【强制】跳过该条 |
| `rel` 不认识 | WHEP §4.10 明确忽略；通用层面为惯例 | 见 §1.5 |
| 某参数值无法解析（坏的 quoted-string） | 规范未规定 | 【惯例】 |
| 整个 `Link` 字段不可解析 | 规范未规定；HTTP 健壮性原则倾向于当作"无链接" | 【惯例】 |

**关键取舍**：RFC 8288 从未授权"因一条坏链接而丢弃整个头"。把整头当作不可分割单元失败，是实现选择，不是规范要求，且与 §1.2 引用的健壮性原则方向相反。

`anchor` 例外：若链接带 `anchor` 而应用无法重设链接上下文，§3.2 要求**整条忽略**（【强制】）。因此带 `anchor` 的 ice-server 链接应跳过，而不是忽略 `anchor` 后继续使用。

## 1.4 WHEP 草案对 ICE 服务器的规定

**位置更正**：ICE 服务器配置在 **§4.8 "STUN/TURN Server Configuration"**（-04 与 -05 相同），**不在 §4.3**。§4.3 是 "Playback Session Set Up"，讲 POST / 201 / 406 / PATCH 的 offer-answer 流程。草案规定的承载位置是 **201 Created 响应**，不是 OPTIONS。

**原文（§4.8）**

> The WHEP Endpoint **MAY** return STUN/TURN server configuration URLs and credentials usable by the client in the "201 Created" response to the HTTP POST request to the WHEP Endpoint URL.
>
> Each STUN/TURN server will be returned using the Link header field [RFC8288] with a "rel" attribute value of "ice-server" as specified in [RFC9725]
>
> It might be also possible to configure the STUN/TURN server URLs with long-term credentials provided by either the broadcasting service or an external TURN provider on the WHEP player, **overriding the values provided by the WHEP Endpoint**.

| 规定 | 分类 |
| --- | --- |
| 端点**可以**在 201 返回 ICE 服务器配置 | 【允许】（MAY） |
| 若返回，写法必须是 `Link` + `rel="ice-server"`，语义按 RFC 9725 | 触发【允许】，写法【强制】 |
| 播放器本地配置**可以覆盖**服务端配置 | 【允许】 |
| 用 OPTIONS 响应携带 ice-server | 【允许】草案未规定；草案只点名 201 |
| 端点不返回时播放器怎么办（空配置直连？还是失败？） | 规范未规定 →【惯例】 |

来源：[WHEP -05 §4.8](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-05#section-4.8)、[全文 txt](https://www.ietf.org/archive/id/draft-ietf-wish-whep-05.txt)、[-04 同节](https://www.ietf.org/archive/id/draft-ietf-wish-whep-04.txt)

## 1.5 WHEP §4.2 与 §4.10：同一 `Link` 头的另两处用法

这两处**不是** ICE 服务器，但用同一个 `Link` 头，解析器必须能共存：

- **§4.2 端点可发现性（【强制】）**：HEAD 回 `200 OK` 时 "MUST also include a Link header field [RFC8288] with a 'rel' attribute value of `profile` as defined in [RFC6906] and a target URI of `urn:ietf:params:whep`"；播放器 "**MUST NOT** identify a URL as a WHEP endpoint based on the Content-Type header field alone"。
- **§4.10 协议扩展（【强制】）**：扩展能力在 201 中以 `Link` 通告，"**WHEP players MUST ignore any Link attribute with an unknown 'rel' attribute value**"。

**结论**：在 WHEP 语境下"忽略未知 `rel`"是**强制**行为。任何"看到 Link 就尝试解析成 ICE 服务器"，或"因出现 `rel="profile"` / `rel="urn:ietf:params:whep:ext:*"` 而报错"的实现，都直接违反 §4.10。

来源：[WHEP §4.2](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-05#section-4.2)、[WHEP §4.10](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-05#section-4.10)、[RFC 6906](https://www.rfc-editor.org/rfc/rfc6906.txt)、[IANA Link Relations](https://www.iana.org/assignments/link-relations/link-relations.xhtml)

## 1.6 RFC 9725 的 `ice-server` 关系与目标属性

RFC 9725（WHIP）§4.6 定义、§6.1 在 IANA 注册；WHEP 只是复用。

> Relation Name:  ice-server
> Description:  Conveys the STUN and TURN servers that can be used by an ICE agent to establish a connection with a peer.
> Reference:  RFC 9725

目标 URI 为 RFC 7064（`stun:` / `stuns:`）与 RFC 7065（`turn:` / `turns:`）定义的服务器 URI；目标属性为 `username`（TURN 用户名）与 `credential`（长期凭据口令）。示例（RFC 9725 Figure 5）：

```http
Link: <stun:stun.example.net>; rel="ice-server"
Link: <turn:turn.example.net?transport=udp>; rel="ice-server";
      username="user"; credential="myPassword"
Link: <turns:turn.example.net?transport=tcp>; rel="ice-server";
      username="user"; credential="myPassword"
```

**互操作要点**

- **【强制】** 多服务器 = 多条 `Link` 头（每行一条），或同一头内逗号分隔的多条 link-value。语义上**没有顺序优先级**（RFC 8288 §2："the relative ordering of links ... is not specified or significant"）。
- **【强制】** 属性名大小写不敏感（RFC 8288 §2.2："MUST be compared in a case-insensitive fashion"），所以 `Username` / `Credential` 必须被识别。
- **【允许】** `credential` 视为长期口令；RFC 9725 的 NOTE 说明 `rel` 值与属性命名 "follows that used in the RTCConfiguration dictionary in Section 4.2.1 of the W3C WebRTC recommendation"，便于映射到 `RTCIceServer.username` / `.credential`。
- **【惯例】** `username` / `credential` 不配套、或出现非标准的 `credential-type` 时如何处理：RFC 9725 未规定。

来源：[RFC 9725 §4.6](https://datatracker.ietf.org/doc/html/rfc9725#section-4.6)、[§6.1 注册](https://datatracker.ietf.org/doc/html/rfc9725#section-6.1)

## 1.7 浏览器侧：W3C WebRTC 与 Chromium 的容错

### W3C WebRTC REC（规范层）

- `RTCIceServer` 的 `urls` 是 `required (DOMString or sequence<DOMString>)`，描述为 "STUN or TURN URI(s) as defined in [RFC7064] and [RFC7065] **or other URI types**"。这句 "or other URI types" 是【允许】——规范不把 `urls` 限死在 stun/turn，也不规定无效条目如何处理。
- `RTCConfiguration.iceServers`："An array of objects describing servers available to be used by ICE ... If the number of ICE servers exceeds an implementation-defined limit, **ignore the ICE servers above the threshold**. This implementation defined limit **MUST be at least 32**." 这是规范里唯一的显式丢弃规则，且是【强制】（截断 + 阈值下限）。

来源：[`RTCIceServer` 字典](https://www.w3.org/TR/webrtc/#dom-rtciceserver)、[`iceServers` 成员](https://www.w3.org/TR/webrtc/#dom-rtcconfiguration-iceservers)、[`setConfiguration()`](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-setconfiguration)

### Chromium（实现层，可取源码验证）

`third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc` 中把 `iceServers` 转成 `webrtc::PeerConnectionInterface::IceServer` 的循环（要点摘录）：

```cpp
for (const RTCIceServer* ice_server : configuration->iceServers()) {
  ...
  } else {  // 既无 urls 也无 url
    exception_state->ThrowTypeError("Malformed RTCIceServer");
    return {};
  }

  for (const String& url_string : url_strings) {
    KURL url(NullUrl(), url_string);
    if (!url.IsValid()) {
      exception_state->ThrowDOMException(DOMExceptionCode::kSyntaxError, ...);
      return {};
    }
    bool is_valid_turn = IsValidTurnURL(url);
    if (!is_valid_turn && !IsValidStunURL(url)) {
      exception_state->ThrowDOMException(DOMExceptionCode::kSyntaxError, ...);
      return {};
    }
    if (is_valid_turn &&
        (!ice_server->hasUsername() || !ice_server->hasCredential())) {
      exception_state->ThrowDOMException(DOMExceptionCode::kInvalidAccessError,
          "Both username and credential are required when the URL scheme is "
          "\"turn\" or \"turns\".");
    }
    converted_urls.push_back(String(url).Utf8());
  }
  ...
}
```

异常消息原文为：`is not a valid URL.` 与 `is not a valid stun or turn URL.`（均由 `kSyntaxError` 承载）。

**可复核的实现事实**

1. **整个 `iceServers` 是"全有或全无"的单元**：任一 URL 非法、或不是 stun/turn，**整个** `new RTCPeerConnection(config)` 抛 `SyntaxError`，并不"只跳过那一条"。
2. TURN URL 缺 `username` 或 `credential` 时抛 `InvalidAccessError`（该分支**没有** `return`，但异常已使构造失败）。
3. 因此"浏览器遇到不可用的 ICE 服务器只跳过"只在有限情形成立：能"跳过"的是**超出实现上限的服务器**（W3C 强制截断）与**空配置**；对**个别坏 URL**，Chromium 是**整体失败**。
4. 推论：若播放器把坏地址原样塞进 `RTCPeerConnection({iceServers})`，损坏范围会从"一条链接"放大到"整个会话建立失败"。**播放器侧预过滤是必要的防御**——但这是工程推论，规范并未如此要求。

来源（固定到 main）：[rtc_peer_connection.cc](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/rtc_peer_connection.cc)。若行号漂移，在该文件搜索 `Malformed RTCIceServer` 与 `is not a valid stun or turn URL` 即可定位。

### 规范 → 实现差异汇总

| 问题 | W3C WebRTC | Chromium | 分类 |
| --- | --- | --- | --- |
| 超过实现上限的 ICE 服务器 | MUST ignore above threshold，下限 ≥32 | 实现上限 | 【强制】 |
| 单个 URL 语法非法 | 未规定 | 整体抛 `SyntaxError` | 【惯例】 |
| 单个 URL 非 stun/turn | 允许 "other URI types" | 整体抛 `SyntaxError`（比规范更严） | 【惯例】 |
| TURN 缺凭据 | 未规定 | 抛 `InvalidAccessError` | 【惯例】 |

## 1.8 "MATCH"：查无此规范

任务提到 "MATCH/浏览器实践"。本文做了三种检索：

1. IETF Datatracker 跨组检索 `name__contains=match`：结果全部是 BGP FlowSpec、LDAP、PKIX 等无关草案，**没有**与 WHEP / WebRTC / ICE 相关的 MATCH 草案。
2. 检索 `draft-ietf-match`、"Media over HTTP" 等关键词：无相关结果。
3. WISH 工作组现有草案只有 `draft-ietf-wish-whip` 与 `draft-ietf-wish-whep`，没有 MATCH。

**结论**：截至核对时，**不存在**与本题相关的 "MATCH" 规范。若上游指的是内部文档或尚未公开的草案，需另行确认名称；在确认前本文**不**把任何 MATCH 主张当作规范依据。功能重叠的现行条款是 RFC 9725 §4.6（`ice-server`）与 WHEP §4.8，已在 §1.4、§1.6 处理。

检索入口：[Datatracker 文档检索](https://datatracker.ietf.org/doc/search)、[WISH WG 文档](https://datatracker.ietf.org/wg/wish/documents/)

---

# 第二部分：WHEP 各方法的状态码

## 2.1 总纲：WHEP §4.1 的"不要按码分支"规则

**原文（§4.1，【强制】）**

> Following the guidelines in [BCP56], **WHEP players MUST NOT match error codes returned by the WHEP endpoints and resources to a specific error cause indicated in this specification.** WHEP players **MUST be able to handle all applicable status codes gracefully falling back to the generic n00 semantics** of a given status code on unknown error codes. WHEP endpoints and resources could convey finer-grained error information by a problem details json object in the response message body of the failed request as per [RFC9457].

以及：

> Those HTTP resources do not have any representation defined in this specification, so the WHEP endpoints and sessions **MUST return a 2xx successful response with no content when a GET request is received**.

这条改变了状态码的**规范地位**：草案给每个码写的含义，是"服务端应该表达什么"（对端点实现的建议），**不是**"播放器可以据此推断精确原因"（对客户端明确禁止）。

因此下文"草案含义"一律属于 **【强制·服务端】**；对播放器只能算 **【惯例】提示**——可用作文案或遥测，不可作为状态机判据。

## 2.2 POST（创建会话，发往 WHEP endpoint URL）

| 状态码 | 出处 | 草案含义 | 分类 |
| --- | --- | --- | --- |
| **201 Created** | §4.3.1 | 接受 offer；回 SDP answer + `Location` | 【强制】服务端；播放器唯一可当成功的 POST 码 |
| **406 Not Acceptable** | §4.3.2 / §4.3.3 | **不是错误**，是"服务端反向 offer"。必须带 `Content-Type: application/sdp`、合法 SDP offer 与 `Location`；可带 `valid-until`（默认 30 秒）。播放器回 PATCH answer | 附加条件成立时【强制】按反向 offer 处理；否则【强制】按普通 HTTP 错误处理 |
| **415 Unsupported Media Type** | §4.3.5 | `Content-Type` 不是 `application/sdp`；"**MUST NOT** include an SDP in the response" | 【强制】服务端 |
| **其余 4XX** | §4.3.5 | SDP 语法错误或不符合 JSEP 初始 offer → "**MUST reject ... with an appropriate 4XX error response**"，**草案刻意不指定具体码** | "是 4xx"【强制】；具体码【允许】 |
| **409 Conflict** | §4.3.9 | 端点要求"正在直播"才允许观看；**SHALL** 带 `Retry-After`（秒）。播放器 MAY 重试，但 **MUST NOT** 早于 `Retry-After` | 【强制】服务端；播放器守 `Retry-After` 为【强制】 |
| **503 Service Unavailable** | §4.7 | 过载或维护，MAY 带 `Retry-After` | 【允许】 |
| **307 Temporary Redirect** | §4.7 | 负载均衡首选；播放器 **SHALL** 支持重定向；此目的 **MUST NOT** 用 301/302 | 【强制】 |
| **401 / 403** | §4.9 / §4.9.1 | 支持 HTTP Authentication 与 Bearer token 是 **MUST**；草案**未**给 401/403 专有语义 | 语义回落 RFC 9110 §15.5.2 / §15.5.4 |
| **404** | — | **草案未为 POST 定义 404** | 【惯例】是否用 404 表达"流不存在"由部署决定 |
| **400** | — | **草案未为 POST 显式定义**；被 §4.3.5 的 "appropriate 4XX" 覆盖 | 【允许】 |
| **412 / 428** | — | 只出现在 **PATCH** 语境（§4.5.1），**不**适用于 POST | — |
| **422** | — | 同上，只出现在 **PATCH** 语境 | — |
| **5xx（500/502/504 等）** | — | 草案未定义，按 RFC 9110 §15.6 | 【惯例】 |

**同一 URL 上的旁路方法**

- **OPTIONS**：§4.4 "The WHEP endpoints **MUST** support OPTIONS requests for CORS"；`200 OK` 的 OPTIONS 响应 SHOULD 带 `Accept-Post: application/sdp`。【强制】
- **HEAD**：§4.2 SHOULD 支持；回 `200 OK` 时 MUST 带 `Content-Type: application/sdp` **且** `Link: <urn:ietf:params:whep>; rel="profile"`。【强制】
- **GET**：MUST 回无 body 的 2xx（§4.1）。

## 2.3 PATCH（会话 URL：trickle ICE / ICE restart / counter-offer 的 answer）

| 状态码 | 出处 | 草案含义 | 分类 |
| --- | --- | --- | --- |
| **204 No Content** | §4.3.2 | 提交 counter-offer 的 SDP answer 后的成功响应 | 【强制】 |
| **200 OK** | §4.5.3 | ICE restart 成功；体内 `application/trickle-ice-sdpfrag`，且 **MUST** 带新 `ETag` | 【强制】 |
| **415 Unsupported Media Type** | §4.5.1 | `Content-Type` 既非 `application/trickle-ice-sdpfrag` 也非 `application/sdp` | 【强制】 |
| **422 Unprocessable Content** | §4.5.1 | ① 已无待答复的 counter-offer 却收到 `application/sdp`；② 只支持 trickle 与 restart 之一，却收到另一种 | 【强制】 |
| **428 Precondition Required** | §4.5.1 | PATCH 缺实体标签 | 【强制】 |
| **412 Precondition Failed** | §4.5.1 | 实体标签不匹配 | 【强制】 |
| **其余 4XX** | §4.5.1 / §4.3.2 | 载荷语法错误或不符合格式 → "appropriate 4XX" | "是 4xx"【强制】；具体码【允许】 |
| **ICE restart 失败** | §4.5.3 | "**MUST** return an appropriate HTTP error code, **MUST NOT** terminate the session immediately, and **MUST keep the existing ICE session**" | 【强制】 |

**422 的原生语义**：RFC 9110 §15.5.21 定义 422 为"懂内容类型（故 415 不合适）、语法正确、但无法处理其中的指令"；草案 §4.5.1 的两种用法正落在此定义内，并显式引用 "as per Section 15.5.21 of [RFC9110]"。

**实体标签语义（§4.5.1）**：支持 ICE restart 的会话 MUST 产生强实体标签标识 ICE 会话，初始值 MUST 出现在 201 的 `ETag`；播放器在不需要匹配特定 ICE 会话时 SHOULD NOT 使用实体标签校验（例如 DELETE）；会话在不需要匹配时 MUST 忽略客户端发来的实体标签（例如 DELETE）。

## 2.4 DELETE（终止会话）

| 项 | 草案出处 | 内容 | 分类 |
| --- | --- | --- | --- |
| 成功码 | §3.2 流程图 / §4.4 | 流程图标注 `200 OK`；§4.4 正文只说"the WHEP session will be removed and the resources freed"，**未规定具体成功码** | `200` 为【惯例】；2xx 为【允许】 |
| **404** | — | **草案未把 404 定义为成功**，也未定义"会话已不存在"的专用码 | 【惯例】 |
| **412 / 428** | §4.5.1 | **明确不适用**：DELETE 不需要实体标签，服务端 MUST 忽略其携带的实体标签 | 【强制】 |

这是最易被误读的一处。§4.4 强调生命周期**不能依赖** DELETE 到达：

> The WHEP session and media server **MUST NOT rely on receiving an HTTP DELETE request** in order to release the resources ... The WHEP session and media server MUST consider the WHEP session terminated ... when the ICE consent expires as per Section 5.1 of [RFC7675], when the DTLS session is closed, or when ICE connectivity is otherwise lost and not re-established.

即：DELETE 是"显式提示"，不是资源释放的必要条件。因此"DELETE 返回 404 表示出错"和"DELETE 返回 404 表示已清理成功"**两种解读都没有规范依据**。与文本一致的做法是把它当作**观测**："HTTP 非成功，但会话可能已被回收"（本仓库已有对应实测记录，见 [whep-cleanup-interop-research.md](whep-cleanup-interop-research.md)）。

## 2.5 RFC 9110 对 4xx / 5xx 的分组语义

**§15.5 Client Error 4xx（【强制】分组定义）**

> The 4xx (Client Error) class of status code indicates that **the client seems to have erred**. Except when responding to a HEAD request, the server **SHOULD** send a representation containing an explanation of the error situation, **and whether it is a temporary or permanent condition**. These status codes are applicable to any request method. User agents **SHOULD** display any included representation to the user.

**§15.6 Server Error 5xx（【强制】分组定义）**

> The 5xx (Server Error) class of status code indicates that **the server is aware that it has erred or is incapable of performing the requested method**. ... These status codes are applicable to any request method.

**三条推论**

1. 分组区分的是"谁的错"：4xx = 客户端似乎有错；5xx = 服务端自知有错或无力完成。**不是**"可重试 / 不可重试"的分界。
2. 分组**不**区分临时与永久：两段都只说服务器 SHOULD 说明是哪一种；具体到码才见端倪（503 明确 "temporary"，404 "does not indicate whether ... temporary or permanent"，410 才是 "likely to be permanent"）。
3. 可重试性来自**具体码与响应头**，不是类。`Retry-After` 见于 503（MAY）、413（SHOULD）；WHEP §4.3.9 把 409 的 `Retry-After` 提升为 SHALL，比 RFC 9110 更强。

**逐码要点**

| 码 | 组 | 关键原文 |
| --- | --- | --- |
| 400 | 4xx | 语法错误 / 消息框架错误 / 欺骗性路由；"cannot or will not process" |
| 401 | 4xx | **MUST** send `WWW-Authenticate`（至少一个 challenge）；若已带凭据即表示该凭据被拒；UA MAY 换凭据重试 |
| 403 | 4xx | 理解请求但拒绝执行；"client **SHOULD NOT** automatically repeat the request with the same credentials"；可用 404 隐藏资源存在性 |
| 404 | 4xx | 无当前表示或不愿披露；不说明临时/永久；启发式可缓存 |
| 405 | 4xx | 方法已知但该资源不支持；**MUST** generate `Allow` |
| 406 | 4xx | 无法产出客户端可接受的内容（WHEP 借用该码位做反向 offer，属协议层复用） |
| 409 | 4xx | 与资源当前状态冲突；服务端 SHOULD 给出足够信息识别冲突来源 |
| 412 | 4xx | 请求头中的条件求值为假（§13 precondition） |
| 415 | 4xx | 内容格式在该资源/方法上不被支持 |
| 422 | 4xx | 懂内容类型（故 415 不合适）、语法正确、但无法处理指令 |
| 428 | RFC 6585 §3 | 服务端要求条件请求（WHEP 用于缺实体标签） |
| 500 | 5xx | 遇到未预期状况 |
| 501 | 5xx | 不支持完成请求所需的功能；方法不被识别时适用 |
| 502 | 5xx | 网关/代理收到上游无效响应 |
| 503 | 5xx | 临时过载或计划维护；MAY 带 `Retry-After`；"does not imply that a server has to use it" |
| 504 | 5xx | 网关/代理时上游未及时响应 |

来源：[RFC 9110 §15.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4)、[§15.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5)、[§15.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6)、[RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.txt)、[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.txt)

## 2.6 被问到但草案"没有写"的码

任务列举的 400 / 401 / 403 / 404 在 **WHEP 草案正文中都没有被赋予专有语义**：

- 它们完全由 RFC 9110 定义（见 §2.5）。
- WHEP 只规定"播放器 MUST NOT 把错误码匹配到特定原因"，以及"未知码回落 n00 通用语义"。
- 因此"WHEP 规定 404 意味着会话不存在""WHEP 规定 403 意味着 token 无效"之类的说法都是**二次推断**，属【惯例】。

---

# 第三部分：结论与可选方案

## 3.1 结论速查表

| # | 结论 | 分类 | 依据 |
| --- | --- | --- | --- |
| L1 | `link-param` 的 token 与 quoted-string 两种写法都必须能解析 | 强制 | RFC 8288 §3 |
| L2 | `rel` 必须存在；重复时取第一个，其余忽略 | 强制 | RFC 8288 §3.3 |
| L3 | `rel` 值可含多个空格分隔的关系；关系名大小写不敏感 | 强制 | RFC 8288 §3.3, §2.1.1, §2.1.2 |
| L4 | 空列表元素必须被解析并忽略 | 强制 | RFC 8288 §3/§1.2 → RFC 9110 §5.6.1 |
| L5 | 未知 `rel` 在 WHEP 中必须被忽略（含 `profile`、`urn:ietf:params:whep:ext:*`） | 强制 | WHEP §4.10 |
| L6 | "一条坏链接导致整个头解析失败"无规范依据 | 惯例 | RFC 8288 未规定；与 §1.2 引用方向相反 |
| L7 | ICE 服务器配置在 **201** 与 **§4.8**（不在 §4.3），写法为 `rel="ice-server"` | 触发【允许】/ 写法【强制】 | WHEP §4.8, RFC 9725 §4.6 |
| L8 | 播放器本地 ICE 配置可覆盖服务端配置 | 允许 | WHEP §4.8 |
| L9 | 服务端不给 ICE 配置时播放器怎么办：规范未规定 | 惯例 | WHEP §4.8 只写 MAY |
| L10 | Chromium 对**单个**坏 URL 抛 `SyntaxError`，整次构造失败；只有超上限才截断 | 惯例（实现事实） | Chromium 源码；W3C `iceServers` 上限条款 |
| L11 | W3C 允许 `urls` 使用 stun/turn 之外的 "other URI types" | 允许 | W3C WebRTC `RTCIceServer.urls` |
| S1 | 播放器 MUST NOT 把状态码映射到 WHEP 特定原因；未知码回落 n00 | 强制 | WHEP §4.1 |
| S2 | POST：201 成功；406 仅在带合法 `application/sdp` offer 时才是反向 offer | 强制 | WHEP §4.3.1–4.3.3 |
| S3 | POST：`Content-Type` 非 `application/sdp` → 415 且不得回 SDP；SDP 不合法 → "appropriate 4XX"（不指定具体码） | 强制 | WHEP §4.3.5 |
| S4 | POST：409 = 暂无直播，带 `Retry-After`；播放器不得提前重试 | 强制 | WHEP §4.3.9 |
| S5 | PATCH：415 / 422 / 428 / 412 的触发条件；ICE restart 成功 = 200 + 新 ETag | 强制 | WHEP §4.5.1, §4.5.3 |
| S6 | ICE restart 失败：返错误码、不得立即终止会话、必须保留原 ICE 会话 | 强制 | WHEP §4.5.3 |
| S7 | DELETE 成功码草案未规定；404 既非规范定义的"成功"也非"失败"；DELETE 不需实体标签 | 惯例 / 强制（忽略标签） | WHEP §4.4, §4.5.1 |
| S8 | 4xx = 客户端似乎有错；5xx = 服务端自知有错；均适用于任意方法，均不区分临时/永久 | 强制（分组） | RFC 9110 §15.5, §15.6 |
| S9 | 401 必须带 `WWW-Authenticate`；403 后不应自动用相同凭据重试 | 强制 | RFC 9110 §15.5.2, §15.5.4 |
| S10 | 400 / 403 / 404 在 WHEP 中无专有语义 | — | WHEP 正文未定义 |

## 3.2 问题一（Link 头解析）：可选方案

### 方案 A —— 严格忠于 RFC 8288，逐条容错（当前实现的方向）

逐条扫描 link-value：缺 `rel` 跳过、`rel` 重复取首个、关系名大小写不敏感且支持多值、只处理 `ice-server`、其余一律忽略；单条目标不是 `stun:/stuns:/turn:/turns:` 时跳过该条而不中断整头。

- 依据：RFC 8288 §3/§3.3、WHEP §4.10【强制】；RFC 9110 §5.6.1【强制】。
- 收益：单条配置错误不放大为会话失败，与 §1.7 揭示的 Chromium 整体失败语义互为补偿。
- 代价：与浏览器行为**不一致**——预过滤会把浏览器本会报错的输入静默修好，服务端配置错误被掩盖。

### 方案 B —— 原样透传给 `RTCPeerConnection`，让浏览器裁决

- 依据：W3C `RTCIceServer.urls` 允许 "other URI types"【允许】；单项失败语义由 UA 定义【惯例】。
- 风险：按 §1.7 的源码事实，一条坏地址会让 `new RTCPeerConnection` 抛 `SyntaxError`，损坏范围被放大到整个会话。对播放器库而言不可接受的可用性回归。**不建议**。

### 方案 C —— 方案 A + 诊断上报

在 A 基础上，把被丢弃的条目（原始值、原因）经既有 `error` / 诊断通道发出，状态继续推进。

- 依据：WHEP §4.1 允许端点用 RFC 9457 表达更细信息【允许】；播放器侧保留可观测性不与规范冲突【惯例】。
- 代价：需要新增诊断字段与文档，属实现决策。

**建议**：保留 **A**，增量引入 **C** 的可观测性；**不**采纳 **B**。若担心与浏览器行为差异，应在文档显式写明"预过滤是防御性设计，不是规范要求"。

**需单独决策的子问题**："声明了 ice-server 但无一可用"是否应硬失败。规范既不支持也不禁止【惯例】；从 §4.8 的 MAY 出发，"端点本无义务提供"更倾向于**降级继续**（空配置直连）而非失败。建议跟解析容错解耦、单独评估。

## 3.3 问题二（状态码判定）：可选方案

### 方案 A —— 按 n00 语义分组处理（与 §4.1 最一致）

只对 **WHEP 显式提升为语义的码**做特殊处理（POST 的 201 / 406，PATCH 的 200 / 204）；其余（含 415 / 422 / 428 / 412）一律按组——2xx 成功、4xx 客户端、5xx 服务端——并通过 `httpStatus` 字段把具体码透传给上层，由上层决定文案与遥测。

- 依据：WHEP §4.1【强制】"MUST NOT match error codes ... to a specific error cause"；RFC 9110 §15.5/§15.6【强制】分组。
- 代价：诊断粒度变粗，需要上层配合使用 `httpStatus`。

### 方案 B —— 逐码精细化分支

为 400/403/404/409/412/415/422/428/5xx 各写专用分支与用户文案。

- 风险：与 §4.1 的 MUST NOT 直接冲突【违背强制】；且 §4.3.5 只说 "appropriate 4XX"，服务端可用码集合大于草案列举，逐码分支必然出现未覆盖分支。
- **不建议**作为主判定路径。可以存在，但只能用于**文案与遥测**，不能驱动会话状态机。

### 方案 C —— 方案 A + `Retry-After` 驱动的重试策略

统一从响应读 `Retry-After`（RFC 9110 §10.2.3，秒或 HTTP-date）。有则按它退避；无则**仅**对 503/5xx 与连接级失败做指数退避；4xx 默认不自动重试（409 例外，按 WHEP §4.3.9）。

- 依据：WHEP §4.3.9【强制】"MUST NOT send a new request before ... Retry-After ... has elapsed"；§4.7【允许】503 + Retry-After；RFC 9110 §15.5.4【强制】403 后不应自动用相同凭据重试。

**建议**：采用 **C**（A 为主体，`Retry-After` 作为唯一重试输入），并保留两项与草案一致的硬约束：

1. POST 的 **406** 只有在"带 `application/sdp` 且 SDP 可解析"时才走反向 offer，否则按普通 4xx 失败（§4.3.3【强制】）；
2. ICE restart 的 PATCH 失败时**保留**原会话、不立即关闭（§4.5.3【强制】）。

## 3.4 与当前实现的对照（仅事实记录，本文不改代码）

| 位置 | 现状 | 与规范对照 |
| --- | --- | --- |
| src/utils/webrtc.ts:109 | `rel` 转小写后按空格拆分匹配 `ice-server` | 与 RFC 8288 §3.3 一致【符合强制】 |
| src/utils/webrtc.ts:113 | 非 stun/turn 目标跳过该条 | 预过滤，【惯例】；与 Chromium 整体失败不同 |
| src/utils/webrtc.ts:126 | 声明了 ice-server 但零可用 → 抛 `SIGNAL_ERROR` | 规范未要求，【惯例】；建议独立评估（见 §3.2 子问题） |
| src/core/http.ts:53 | 用 **OPTIONS** 响应的 `Link` 取 ICE 服务器 | §4.8 只规定 201；OPTIONS 方案【允许】但服务端未必提供 |
| src/core/http.ts:32 | 404 → `NOT_FOUND_ERROR`，其余非 2xx → `REQUEST_ERROR` | 与 §4.1 的"不按码定原因"存在张力 |
| src/core/http.ts:83 | POST 只接受 201 | 与 §4.3.1 一致；但**未处理 406 反向 offer**，会直接判失败 |
| src/core/http.ts:125 | PATCH 只接受 204 | 与 §4.3.2 一致；但 §4.5.3 的 ICE restart 成功是 **200 + 新 ETag**，会被误判为失败 |
| src/core/http.ts:106 | DELETE 接受任意 `ok` | 与"草案未规定 DELETE 成功码"相容 |

## 3.5 未决事项

1. **"MATCH" 的身份**：需上游确认所指文档。若确为内部规范或未公开草案，应补正式引用后再评估（目前按"不存在"处理）。
2. **OPTIONS 还是 201 取 ICE 服务器**：草案只规范 201；采用 OPTIONS 需服务端配合，属部署约定【允许】。已有实现文档需与此对齐。
3. **"声明但零可用"是否硬失败**：见 §3.2，建议独立决策。

---

## 附：一手来源清单

- RFC 8288 Web Linking — https://www.rfc-editor.org/rfc/rfc8288.txt（§1.2、§2、§2.1.1、§2.1.2、§2.2、§3、§3.1—§3.5）
- RFC 9110 HTTP Semantics — https://www.rfc-editor.org/rfc/rfc9110.txt（§5.6.1、§10.2.3、§13.1.1、§15.4、§15.5、§15.6）
- RFC 6585 Additional HTTP Status Codes（428） — https://www.rfc-editor.org/rfc/rfc6585.txt
- RFC 6906 `profile` Link Relation Type — https://www.rfc-editor.org/rfc/rfc6906.txt
- RFC 9457 Problem Details for HTTP APIs — https://www.rfc-editor.org/rfc/rfc9457.txt
- RFC 9725 WHIP（`ice-server` 关系类型） — https://www.rfc-editor.org/rfc/rfc9725.txt
- WHEP `draft-ietf-wish-whep-05` — https://www.ietf.org/archive/id/draft-ietf-wish-whep-05.txt ；https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep-05
- WHEP `draft-ietf-wish-whep-04` — https://www.ietf.org/archive/id/draft-ietf-wish-whep-04.txt
- WHEP 草案源码（wish-wg） — https://github.com/wish-wg/webrtc-http-egress-protocol
- W3C WebRTC: Real-Time Communication in Browsers — https://www.w3.org/TR/webrtc/
- Chromium Blink `rtc_peer_connection.cc` — https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/modules/peerconnection/rtc_peer_connection.cc
- IANA Link Relations Registry — https://www.iana.org/assignments/link-relations/link-relations.xhtml
- IETF Datatracker 文档检索（用于确认 MATCH 不存在） — https://datatracker.ietf.org/doc/search
