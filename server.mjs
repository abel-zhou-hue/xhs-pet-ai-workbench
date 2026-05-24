import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 4174);
const reviewStorePath = join(root, ".data", "reviews.json");
const aiConfigPath = join(root, ".data", "ai-config.json");
const textGenerationTimeoutMs = 65000;
const topicGenerationTimeoutMs = 25000;
const defaultAiConfig = {
  text: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash"
  },
  image: {
    apiKey: "",
    baseUrl: "https://api.apimart.ai/v1",
    model: "gpt-image-2"
  }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchJsonWithDeadline(url, options, ms, timeoutMessage, errorScope) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(timeoutMessage);
      error.name = "AbortError";
      reject(error);
    }, ms);
  });
  const requestPromise = (async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw externalError(errorScope, response.status, await readShortText(response));
    }
    return response.json();
  })();
  requestPromise.catch(() => {});
  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function readShortText(response, max = 600) {
  const text = await response.text();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function cleanExternalError(scope, status, raw = "") {
  const text = String(raw || "");
  if (status === 524 || /524|A timeout occurred|Cloudflare/i.test(text)) {
    return `${scope} 524：APIMart 上游超时，任务可能仍在排队或处理中，请稍后检查进度/重试。`;
  }
  if (status === 429) return `${scope} 429：请求过于频繁，请稍后再试。`;
  if (status === 402) return `${scope} 402：账户余额不足或额度不可用。`;
  if (status === 401) return `${scope} 401：API Key 验证失败。`;
  if (status === 400) return `${scope} 400：请求参数或提示词未通过平台校验。`;
  const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return `${scope} ${status}${stripped ? `：${stripped.slice(0, 180)}` : ""}`;
}

function externalError(scope, status, raw = "") {
  const error = new Error(cleanExternalError(scope, status, raw));
  error.status = status;
  error.transient = status === 524 || status === 408 || status === 429 || /timeout|timed out|Cloudflare/i.test(String(raw || ""));
  return error;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20_000_000) {
        req.destroy(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readReviews() {
  try {
    const raw = await readFile(reviewStorePath, "utf8");
    const reviews = JSON.parse(raw);
    return Array.isArray(reviews) ? reviews : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeReviews(reviews) {
  await mkdir(dirname(reviewStorePath), { recursive: true });
  await writeFile(reviewStorePath, JSON.stringify(reviews.slice(0, 100), null, 2));
}

async function readStoredAiConfig() {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(aiConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const savedText = stored.text || stored;
  const savedImage = stored.image || {};
  return {
    text: {
      apiKey: savedText.apiKey || "",
      baseUrl: savedText.baseUrl || "",
      model: savedText.model || ""
    },
    image: {
      apiKey: savedImage.apiKey || "",
      baseUrl: savedImage.baseUrl || "",
      model: savedImage.model || ""
    }
  };
}

function normalizeTextModelName(model) {
  const text = String(model || "").trim();
  if (text === "deepseek-v4") return "deepseek-v4-pro";
  return text || defaultAiConfig.text.model;
}

function normalizeImageModelName(model) {
  const text = String(model || "").trim();
  if (!text || text === "image2.0" || text === "gpt-image-2.0") return defaultAiConfig.image.model;
  return text;
}

async function readAiConfig() {
  const saved = await readStoredAiConfig();
  return {
    text: {
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || saved.text.apiKey || defaultAiConfig.text.apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || saved.text.baseUrl || defaultAiConfig.text.baseUrl,
      model: normalizeTextModelName(process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || saved.text.model || defaultAiConfig.text.model)
    },
    image: {
      apiKey: process.env.IMAGE2_API_KEY || saved.image.apiKey || defaultAiConfig.image.apiKey,
      baseUrl: process.env.IMAGE2_BASE_URL || saved.image.baseUrl || defaultAiConfig.image.baseUrl,
      model: normalizeImageModelName(process.env.IMAGE2_MODEL || saved.image.model || defaultAiConfig.image.model)
    },
    lockedByEnv: Boolean(
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.DEEPSEEK_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.IMAGE2_API_KEY ||
      process.env.IMAGE2_BASE_URL ||
      process.env.IMAGE2_MODEL
    )
  };
}

async function writeAiConfig(config) {
  const saved = await readStoredAiConfig();
  const current = await readAiConfig();
  const next = {
    text: {
      apiKey: typeof config.textApiKey === "string" && config.textApiKey.trim() ? config.textApiKey.trim() : saved.text.apiKey,
      baseUrl: typeof config.textBaseUrl === "string" && config.textBaseUrl.trim() ? config.textBaseUrl.trim() : saved.text.baseUrl || current.text.baseUrl,
      model: normalizeTextModelName(typeof config.textModel === "string" && config.textModel.trim() ? config.textModel.trim() : saved.text.model || current.text.model)
    },
    image: {
      apiKey: typeof config.imageApiKey === "string" && config.imageApiKey.trim() ? config.imageApiKey.trim() : saved.image.apiKey,
      baseUrl: typeof config.imageBaseUrl === "string" ? config.imageBaseUrl.trim() : saved.image.baseUrl || current.image.baseUrl,
      model: normalizeImageModelName(typeof config.imageModel === "string" && config.imageModel.trim() ? config.imageModel.trim() : saved.image.model || current.image.model)
    }
  };
  await mkdir(dirname(aiConfigPath), { recursive: true });
  await writeFile(aiConfigPath, JSON.stringify(next, null, 2));
  return { ...next, lockedByEnv: false };
}

function publicAiConfig(config) {
  return {
    modelConfigured: Boolean(config.text.apiKey),
    baseUrl: config.text.baseUrl,
    model: config.text.model,
    keyPreview: config.text.apiKey ? `${config.text.apiKey.slice(0, 7)}...${config.text.apiKey.slice(-4)}` : "",
    text: {
      configured: Boolean(config.text.apiKey),
      baseUrl: config.text.baseUrl,
      model: config.text.model,
      keyPreview: config.text.apiKey ? `${config.text.apiKey.slice(0, 7)}...${config.text.apiKey.slice(-4)}` : ""
    },
    image: {
      configured: Boolean(config.image.apiKey && config.image.baseUrl),
      baseUrl: config.image.baseUrl,
      model: config.image.model,
      keyPreview: config.image.apiKey ? `${config.image.apiKey.slice(0, 7)}...${config.image.apiKey.slice(-4)}` : ""
    },
    lockedByEnv: Boolean(config.lockedByEnv)
  };
}

function cleanComments(comments) {
  if (!comments || typeof comments !== "object" || Array.isArray(comments)) return {};
  return Object.fromEntries(
    Object.entries(comments).map(([page, value]) => [String(page), String(value || "").trim()])
  );
}

function normalizeReviewRecord(record, existing = null) {
  const now = new Date().toISOString();
  const status = ["pending", "approved", "changes"].includes(record.status) ? record.status : existing?.status || "pending";
  return {
    id: existing?.id || record.id || randomUUID(),
    createdAt: existing?.createdAt || record.createdAt || now,
    updatedAt: now,
    submittedAt: record.submittedAt || (status === "pending" ? "" : existing?.submittedAt || now),
    status,
    reviewer: String(record.reviewer ?? existing?.reviewer ?? ""),
    overall: String(record.overall ?? existing?.overall ?? ""),
    comments: cleanComments(record.comments ?? existing?.comments),
    style: String(record.style || existing?.style || "doctor"),
    visualPlan: record.visualPlan || record.deck?.visualPlan || existing?.visualPlan || null,
    deck: record.deck || existing?.deck || null
  };
}

async function upsertReviewRecord(record) {
  const reviews = await readReviews();
  const index = reviews.findIndex(item => item.id === record.id);
  const existing = index >= 0 ? reviews[index] : null;
  const nextRecord = normalizeReviewRecord(record, existing);
  if (!nextRecord.deck) {
    throw new Error("Missing review deck");
  }
  const nextReviews = [nextRecord, ...reviews.filter(item => item.id !== nextRecord.id)];
  await writeReviews(nextReviews);
  return nextRecord;
}

async function getReviewRecord(id) {
  const reviews = await readReviews();
  return reviews.find(item => item.id === id) || null;
}

function cleanTopic(topic = "") {
  return String(topic).replace(/[？?。！!]/g, "").trim() || "宠物健康问题";
}

function inferIssue(topic = "") {
  const text = cleanTopic(topic);
  if (/中暑|热射|高温/.test(text)) return "中暑";
  if (/吐|呕/.test(text)) return "呕吐";
  if (/拉稀|腹泻|软便/.test(text)) return "腹泻";
  if (/尿|猫砂/.test(text)) return "排尿异常";
  if (/咳|喷嚏|呼吸/.test(text)) return "呼吸道症状";
  if (/皮肤|痒|掉毛/.test(text)) return "皮肤瘙痒";
  if (/驱虫/.test(text)) return "驱虫";
  if (/疫苗/.test(text)) return "疫苗";
  if (/体检|检查|报告/.test(text)) return "检查项目";
  return text.replace(/[，,：:、].*$/, "").slice(0, 8);
}

function petLabel(pet) {
  return pet === "猫狗通用" ? "宠物" : pet || "宠物";
}

function generateNote(payload) {
  const issue = inferIssue(payload.topic);
  const pet = petLabel(payload.pet);
  const hospital = payload.brand?.hospital || "宠物医院";
  const doctor = payload.brand?.doctor || "宠物医生";
  const phone = payload.brand?.phone || "";
  const conversion = payload.conversionGoal || "预约检查";
  const highRisk = /急救|中暑|误食|排尿|呼吸|抽搐/.test(`${payload.contentType}${issue}`);

  const cards = [
    {
      page: 1,
      layout: "cover",
      label: "封面",
      title: `${pet}${issue}，先分清轻重缓急`,
      subtitle: "不要先搜药，先看精神、频率和伴随症状。",
      points: ["精神食欲有没有变差", "一天内出现了几次", "有没有疼痛血便尿血", "近期是否误食或换粮"],
      insight: "宠主先做风险初筛，医生再结合检查判断原因。",
      doctorNote: `${hospital}提醒：科普内容不能替代面诊。`,
      riskLevel: highRisk ? "medium" : "low"
    },
    {
      page: 2,
      layout: "symptom_map",
      label: "观察地图",
      title: "医生会先问这 5 件事",
      subtitle: "这些信息比一句“它不舒服”更能帮助判断。",
      points: ["第一次出现的时间点", "一天内发生的次数", "精神食欲是否下降", "排便排尿有没有异常", "照片视频或可疑物品"],
      insight: `判断${issue}不是只看一次症状，而是看变化趋势和伴随表现。`,
      doctorNote: "问诊前记录越清楚，医生越容易判断。",
      riskLevel: highRisk ? "high" : "medium"
    },
    {
      page: 3,
      layout: "clinic_tip",
      label: "可能原因",
      title: "原因通常不止一种",
      subtitle: "饮食、寄生虫、感染、异物和慢病都可能相关。",
      points: ["偶发不代表完全没事", "频繁出现需要排查病因", "伴随其他症状要优先就医", "年龄和病史会影响判断"],
      insight: "医生会结合年龄、病史、触诊和必要检查来缩小范围。",
      doctorNote: "科普内容不能替代面诊和检查。",
      riskLevel: "low"
    },
    {
      page: 4,
      layout: "mistake",
      label: "避坑",
      title: "这几件事不建议做",
      subtitle: "很多宠主是好心，但处理方式可能让情况更复杂。",
      points: ["不要自行使用人用药", "不要强行灌水灌食", "不要直接套网上偏方", "不要拖到精神很差才处理"],
      insight: "不确定原因时，先减少刺激并保留信息，比盲目处理更稳妥。",
      doctorNote: "用药和处置建议由医生结合检查判断。",
      riskLevel: "high"
    },
    {
      page: 5,
      layout: "warning",
      label: "就医信号",
      title: "出现这些情况，尽快到院",
      subtitle: "以下信号提示风险升高，不建议继续在家观察。",
      points: ["精神明显变差或不吃", "反复出现或越来越重", "伴随血便尿血或疼痛", "疑似误食中毒或摔伤", "呼吸异常或意识异常"],
      insight: "高风险症状越早明确原因，后续处理越主动。",
      doctorNote: `${hospital}提醒：路上尽量保持安静和通风。`,
      riskLevel: "high"
    },
    {
      page: 6,
      layout: "timeline",
      label: "到院准备",
      title: "来医院前这样准备",
      subtitle: "准备越充分，医生越容易快速判断。",
      points: ["记录症状开始时间", "拍下异常表现或排泄物", "带上可疑物或包装", "说明近期饮食用药变化", "提前电话说明情况"],
      insight: "按时间线记录，有助于判断症状是在缓解还是加重。",
      doctorNote: `${conversion}时，把这些信息一起带给医生。`,
      riskLevel: "low"
    },
    {
      page: 7,
      layout: "summary",
      label: "总结",
      title: "判断公式：频率 + 精神 + 伴随症状",
      subtitle: "宠主先判断风险，不要急着自行处理。",
      points: ["偶发轻微先记录观察", "反复或精神差尽快就医", "高风险信号不要拖延", `${conversion}前整理好信息`],
      insight: "科普帮你判断轻重缓急，但最终诊断需要面诊和检查。",
      doctorNote: "具体情况需结合年龄、病史和检查结果判断。",
      riskLevel: "low"
    }
  ];

  return {
    source: "local-api-mock",
    noteTitle: `${pet}${issue}科普笔记`,
    titles: [
      `${pet}${issue}要不要去医院？先看这 4 点`,
      `宠物医生提醒：${pet}${issue}这些信号别忽视`,
      `${pet}${issue}后，宠主在家可以观察什么？`
    ],
    caption: `很多宠主遇到${pet}${issue}，第一反应是上网搜药或先等等。\n\n更稳妥的做法是：先记录频率、精神、食欲、排便排尿和伴随症状。若反复出现、精神变差或疑似误食，建议尽快到院让医生评估。\n\n${hospital}｜${doctor}${phone ? "｜" + phone : ""}`,
    hashtags: ["宠物医院", "养宠科普", `${pet}健康`, `${issue}怎么办`, "宠物医生", conversion],
    cards,
    compliance: {
      status: highRisk ? "warned" : "passed",
      checks: ["diagnosis_boundary", "drug_safety", "treatment_claim", "triage_hint"]
    }
  };
}

function systemPrompt() {
  return [
    "你是宠物医院小红书图文笔记策划助手。",
    "你只输出 JSON，不输出 Markdown。",
    "内容必须面向普通宠主，专业但不恐吓。",
    "必须结合输入里的医院画像、服务重点、区域客群和品牌风格，不要生成通用模板感内容。",
    "禁止远程确诊、禁止承诺疗效、禁止建议自行使用处方药或人用药。",
    "禁止编造医院电话、24小时急诊、优惠、免排队、专病门诊等未提供的服务信息。",
    "禁止输出未经证实的比例、治愈率、死亡时间、黄金救治时间等具体数据。",
    "高风险症状必须建议尽快到宠物医院由医生评估。",
    "每张卡片必须有明确版式类型：cover、symptom_map、mistake、clinic_tip、timeline、report、summary。",
    "每张卡片的 points 输出 4-6 条，每条 12-24 个中文字符，避免空泛口号。",
    "subtitle 要补充专业判断逻辑，不要只是重复标题。",
    "医生提示要给出医疗边界、观察重点或到院准备。"
  ].join("\n");
}

function userPrompt(payload) {
  return JSON.stringify({
    task: "生成宠物医院小红书图文笔记",
    requirements: {
      cardCount: payload.output?.cardCount || 7,
      layouts: ["cover", "symptom_map", "clinic_tip", "mistake", "warning", "timeline", "summary"],
      returnJsonOnly: true
    },
    input: payload,
    responseShape: {
      source: "openai-compatible",
      noteTitle: "string",
      titles: ["string"],
      caption: "string",
      hashtags: ["string"],
      cards: [{
        page: 1,
        layout: "cover | symptom_map | mistake | clinic_tip | timeline | report | summary",
        label: "封面",
        title: "string",
        subtitle: "string",
        points: ["string"],
        insight: "string",
        formula: "string",
        doctorNote: "string",
        riskLevel: "low | medium | high"
      }],
      compliance: {
        status: "passed | warned | needs_review",
        checks: ["diagnosis_boundary", "drug_safety", "treatment_claim", "triage_hint"]
      }
    }
  });
}

function topicSystemPrompt() {
  return [
    "你是宠物医院小红书账号的选题策划助手。",
    "你只输出 JSON，不输出 Markdown。",
    "选题必须结合医院定位、服务重点、区域客群、品牌气质和转化目标。",
    "选题面向普通宠主，标题要具体、有收藏价值，但不能恐吓或夸大。",
    "不能编造医院没有提供的服务，不能承诺疗效，不能使用绝对化医疗结论。",
    "每个选题要标注 pet、type、style、cta、audience 和一句推荐原因。",
    "type 只能从：症状判断、日常护理、预防科普、急救提醒、检查项目解释 中选择。",
    "style 只能从：doctor、warm、alert、report、cute、premium 中选择。",
    "pet 只能从：猫、狗、猫狗通用 中选择。",
    "cta 只能从：预约检查、私信咨询、收藏备用、到院评估 中选择。"
  ].join("\n");
}

function topicUserPrompt(payload) {
  return JSON.stringify({
    task: "为宠物医院小红书账号生成本周推荐选题",
    requirements: {
      topicCount: payload.output?.topicCount || 8,
      returnJsonOnly: true,
      makeTopicsDistinct: true,
      prioritizeHospitalProfile: true
    },
    input: payload,
    responseShape: {
      source: "openai-compatible",
      topics: [{
        title: "string",
        pet: "猫 | 狗 | 猫狗通用",
        type: "症状判断 | 日常护理 | 预防科普 | 急救提醒 | 检查项目解释",
        style: "doctor | warm | alert | report | cute | premium",
        cta: "预约检查 | 私信咨询 | 收藏备用 | 到院评估",
        audience: "新手宠主 | 幼宠家庭 | 老年宠家庭 | 多宠家庭",
        reason: "string"
      }]
    }
  });
}

function seasonLabel(date = new Date()) {
  const month = date.getMonth() + 1;
  if ([3, 4, 5].includes(month)) return "春季";
  if ([6, 7, 8].includes(month)) return "夏季";
  if ([9, 10, 11].includes(month)) return "秋季";
  return "冬季";
}

function normalizeTopicItem(item = {}, fallback = {}) {
  const pets = ["猫", "狗", "猫狗通用"];
  const types = ["症状判断", "日常护理", "预防科普", "急救提醒", "检查项目解释"];
  const styles = ["doctor", "warm", "alert", "report", "cute", "premium"];
  const ctas = ["预约检查", "私信咨询", "收藏备用", "到院评估"];
  const audiences = ["新手宠主", "幼宠家庭", "老年宠家庭", "多宠家庭"];
  return {
    title: sanitizeMedicalCopy(item.title || fallback.title || "宠物健康问题，宠主先看什么？", {}),
    pet: pets.includes(item.pet) ? item.pet : fallback.pet || "猫狗通用",
    type: types.includes(item.type) ? item.type : fallback.type || "症状判断",
    style: styles.includes(item.style) ? item.style : fallback.style || "doctor",
    cta: ctas.includes(item.cta) ? item.cta : fallback.cta || "预约检查",
    audience: audiences.includes(item.audience) ? item.audience : fallback.audience || "新手宠主",
    reason: sanitizeMedicalCopy(item.reason || fallback.reason || "匹配医院定位", {})
  };
}

function generateTopicRecommendations(payload, source = "local-topic-engine") {
  const profile = [
    payload.brand?.hospital,
    payload.brand?.mood,
    payload.hospitalProfile?.positioning,
    payload.hospitalProfile?.services,
    payload.hospitalProfile?.localAudience,
    payload.hospitalProfile?.contentStyleGuide,
    payload.preferredPet,
    payload.contentType
  ].filter(Boolean).join(" ");
  const hospital = payload.brand?.hospital || "宠物医院";
  const preferredPet = ["猫", "狗", "猫狗通用"].includes(payload.preferredPet) ? payload.preferredPet : "猫狗通用";
  const audience = payload.audience || "新手宠主";
  const cta = payload.conversionGoal || "预约检查";
  const season = seasonLabel();
  const bank = [];
  const add = (item, condition = true) => {
    if (!condition) return;
    if (bank.some(topic => topic.title === item.title)) return;
    bank.push(normalizeTopicItem(item, { pet: preferredPet, audience, cta }));
  };

  add({ title: "猫咪频繁进猫砂盆，可能是什么信号？", pet: "猫", type: "急救提醒", style: "alert", cta: "到院评估", audience, reason: "猫科与泌尿风险高频" }, /猫|猫科|猫病|猫咪/.test(profile));
  add({ title: "猫咪呕吐，什么时候要去医院？", pet: "猫", type: "症状判断", style: "doctor", cta, audience, reason: "新手宠主常见困惑" }, /猫|新手|社区/.test(profile));
  add({ title: "狗狗拉稀，宠主在家先看什么？", pet: "狗", type: "症状判断", style: "doctor", cta: "到院评估", audience, reason: "适合社区综合门诊" }, /狗|综合|社区|犬/.test(profile));
  add({ title: "皮肤痒总反复，宠主别只想着洗澡", pet: "猫狗通用", type: "症状判断", style: "doctor", cta: "预约检查", audience, reason: "匹配皮肤耳道服务" }, /皮肤|耳道|瘙痒|耳/.test(profile));
  add({ title: "宠物耳朵有味道，是脏了还是发炎？", pet: "猫狗通用", type: "症状判断", style: "warm", cta: "预约检查", audience, reason: "耳道问题转化明确" }, /耳道|皮肤|耳/.test(profile));
  add({ title: "宠物体检报告怎么看？别只盯红箭头", pet: "猫狗通用", type: "检查项目解释", style: "report", cta: "预约检查", audience, reason: "匹配体检预防定位" }, /体检|检查|预防|健康档案/.test(profile));
  add({ title: "驱虫多久一次？新手宠主收藏版", pet: "猫狗通用", type: "预防科普", style: "report", cta: "收藏备用", audience: "新手宠主", reason: "基础预防高收藏" }, /驱虫|疫苗|预防|新手/.test(profile));
  add({ title: "绝育前后，宠主要提前准备什么？", pet: "猫狗通用", type: "日常护理", style: "warm", cta: "预约检查", audience, reason: "匹配绝育服务链路" }, /绝育|手术|外科/.test(profile));
  add({ title: "宠物口臭，不一定只是没刷牙", pet: "猫狗通用", type: "症状判断", style: "premium", cta: "预约检查", audience, reason: "匹配口腔洁牙服务" }, /口腔|牙|洁牙/.test(profile));
  add({ title: `${season}宠物护理，最容易忽略这几件事`, pet: "猫狗通用", type: "日常护理", style: "warm", cta: "收藏备用", audience, reason: "结合当季养宠场景" });
  add({ title: "幼宠到家第一周，最容易踩的 5 个坑", pet: preferredPet === "狗" ? "狗" : "猫", type: "日常护理", style: "cute", cta: "收藏备用", audience: "幼宠家庭", reason: "适合新客教育" });
  add({ title: "老年宠体检，哪些项目更值得关注？", pet: "猫狗通用", type: "检查项目解释", style: "premium", cta: "预约检查", audience: "老年宠家庭", reason: "适合长期健康管理" });
  add({ title: "多宠家庭出现呕吐腹泻，要先隔离吗？", pet: "猫狗通用", type: "急救提醒", style: "alert", cta: "到院评估", audience: "多宠家庭", reason: "匹配多宠家庭传播风险" });

  while (bank.length < (payload.output?.topicCount || 8)) {
    add({
      title: `${hospital}医生提醒：宠物异常先记录这 4 件事`,
      pet: preferredPet,
      type: "症状判断",
      style: "doctor",
      cta,
      audience,
      reason: "通用问诊效率选题"
    });
    break;
  }

  return {
    source,
    generatedAt: new Date().toISOString(),
    topics: bank.slice(0, payload.output?.topicCount || 8)
  };
}

function normalizeTopicRecommendations(result, payload, config) {
  const fallback = generateTopicRecommendations(payload);
  const topics = Array.isArray(result.topics) ? result.topics : [];
  const normalized = topics.map((item, index) => normalizeTopicItem(item, fallback.topics[index] || fallback.topics[0])).filter(item => item.title);
  const combined = [...normalized];
  for (const item of fallback.topics) {
    if (combined.length >= (payload.output?.topicCount || 8)) break;
    if (!combined.some(topic => topic.title === item.title)) combined.push(item);
  }
  return {
    source: `text-model:${config.text.model}`,
    generatedAt: new Date().toISOString(),
    topics: combined.slice(0, payload.output?.topicCount || 8)
  };
}

function sanitizeMedicalCopy(value, payload) {
  const phone = payload.brand?.phone || "";
  const contact = phone ? `可先电话联系医院：${phone}` : "可先电话联系医院确认接诊安排";
  return String(value || "")
    .replace(/24\s*小时急诊电话[:：]?\s*[A-Za-z0-9Xx\-—\s]+/g, contact)
    .replace(/提供\s*24\s*小时急诊/g, "如遇紧急情况，建议尽快联系医院")
    .replace(/24\s*小时急诊/g, "紧急情况")
    .replace(/夜诊勿犹豫[，,。]?/g, "")
    .replace(/免排队/g, "提前沟通就诊安排")
    .replace(/专病门诊/g, "医生咨询")
    .replace(/黄金救治时间/g, "及时处理时机")
    .replace(/\d+%/g, "部分")
    .replace(/数小时内死亡/g, "风险升高")
    .replace(/晚一步都可能危及生命/g, "这些情况不建议拖延")
    .replace(/必须立即进行临床检查和输液治疗/g, "建议尽快由医生进行临床评估和必要处理")
    .replace(/立即去医院/g, "尽快去医院")
    .replace(/立即就医/g, "尽快就医")
    .replace(/添加微信预约可提前沟通就诊安排/g, "可提前联系医院了解就诊安排")
    .trim();
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model did not return JSON");
  return JSON.parse(match[0]);
}

function normalizeModelNote(note, payload, config) {
  const fallback = generateNote(payload);
  const cards = Array.isArray(note.cards) ? note.cards : fallback.cards;
  return {
    source: `text-model:${config.text.model}`,
    modelRawSource: note.source || "",
    noteTitle: sanitizeMedicalCopy(note.noteTitle || fallback.noteTitle, payload),
    titles: (Array.isArray(note.titles) && note.titles.length ? note.titles : fallback.titles)
      .map(title => sanitizeMedicalCopy(title, payload)),
    hashtags: Array.isArray(note.hashtags) && note.hashtags.length ? note.hashtags : fallback.hashtags,
    cards: cards.map((card, index) => ({
      page: Number(card.page || index + 1),
      layout: card.layout || (index === 0 ? "cover" : "checklist"),
      label: sanitizeMedicalCopy(card.label || `第 ${index + 1} 页`, payload),
      title: sanitizeMedicalCopy(card.title || fallback.cards[index]?.title || "", payload),
      subtitle: sanitizeMedicalCopy(card.subtitle || fallback.cards[index]?.subtitle || "", payload),
      points: Array.isArray(card.points) ? card.points.slice(0, 5).map(point => sanitizeMedicalCopy(point, payload)) : [],
      insight: sanitizeMedicalCopy(card.insight || card.clinicalLogic || fallback.cards[index]?.insight || "", payload),
      formula: sanitizeMedicalCopy(card.formula || "", payload),
      doctorNote: sanitizeMedicalCopy(card.doctorNote || card.note || "具体情况需结合面诊和检查结果判断。", payload),
      riskLevel: ["low", "medium", "high"].includes(card.riskLevel) ? card.riskLevel : "low"
    })),
    caption: sanitizeMedicalCopy(note.caption || fallback.caption, payload),
    compliance: note.compliance || fallback.compliance
  };
}

function imagePromptText(value, max = 80) {
  return String(value || "")
    .replace(/禁食/g, "饮食安排")
    .replace(/给药/g, "用药处理")
    .replace(/自行用药/g, "自行处理")
    .replace(/严重/g, "风险较高")
    .replace(/炎症/g, "健康指标")
    .replace(/血气\/电解质/g, "基础代谢指标")
    .replace(/治疗/g, "处理建议")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function buildVisualPrompt(payload) {
  const brand = payload.brand || {};
  const visual = payload.visual || {};
  const imagePlan = payload.imageModelPlan || {};
  const note = payload.generatedNote || {};
  const profile = payload.hospitalProfile || {};
  const noteCards = Array.isArray(note.cards) ? note.cards.slice(0, 7) : [];
  const currentCard = note.currentCard || noteCards[0] || {};
  const pageNo = note.currentPage || currentCard.page || 1;
  const title = payload.topic || "宠物健康科普";
  const hospital = brand.hospital || "宠物医院";
  const mood = brand.mood || visual.mood || "专业可信";
  const primary = brand.primaryColor || visual.primary || "#18835f";
  const secondary = brand.secondaryColor || visual.secondary || "#72b7df";
  return [
    "生成一张完整、可直接发布的小红书宠物医院知识卡片，不要只做背景，不要只做插画。",
    `为${hospital}生成第 ${pageNo} 页 3:4 竖版知识卡片。`,
    `主题：${title}；内容类型：${payload.contentType || "科普"}；宠物：${payload.pet || "猫狗通用"}。`,
    note.title ? `整组笔记标题：${imagePromptText(note.title, 42)}。` : "",
    currentCard.label ? `本页栏目：${imagePromptText(currentCard.label, 20)}。` : "",
    currentCard.title ? `本页大标题：${imagePromptText(currentCard.title, 32)}。` : "",
    currentCard.subtitle ? `本页副标题：${imagePromptText(currentCard.subtitle, 46)}。` : "",
    currentCard.points?.length ? `本页要点：${currentCard.points.slice(0, 5).map(point => imagePromptText(point, 28)).join("；")}。` : "",
    currentCard.insight ? `本页专业解释：${imagePromptText(currentCard.insight, 60)}。` : "",
    currentCard.doctorNote ? `医生提示：${imagePromptText(currentCard.doctorNote, 56)}。` : "",
    noteCards.length ? `整组卡片结构：${noteCards.map(card => `${card.page || ""}${card.label || ""}:${card.title || ""}`).join("；")}。` : "",
    `医院气质：${mood}；主色：${primary}；辅色：${secondary}。`,
    profile.positioning ? `医院定位：${imagePromptText(profile.positioning, 70)}。` : "",
    profile.services ? `重点服务：${imagePromptText(profile.services, 70)}。` : "",
    profile.contentStyleGuide ? `内容风格：${imagePromptText(profile.contentStyleGuide, 70)}。` : "",
    imagePlan.promptBase ? `用户补充视觉要求：${imagePlan.promptBase}。` : "",
    "画面必须包含清晰中文信息层级：标题、副标题、要点区、医生提示区、页码或系列感标识。",
    "要像真实的小红书医疗科普卡片：专业、清爽、吸睛、适合宠主收藏。",
    "可以使用医院 Logo 参考图中的颜色和标志气质，但不要编造电话、地址、优惠、疗效承诺。",
    "请使用安全中性的科普措辞，避免处方、具体治疗、禁食、给药、严重等容易触发审核的词。",
    "如果生成中文小字，请尽量保持可读；避免密密麻麻的小号正文。",
    "风格适合宠物医院专业科普：可信、清爽、适合宠主收藏，不要恐吓、不要医疗夸张。"
  ].filter(Boolean).join("\n");
}

function visualBackgroundFor(mood, style) {
  if (style === "alert") return "#fff7f4";
  if (style === "report") return "#f5f9ff";
  if (style === "cute") return "#fffdf2";
  if (style === "premium" || mood === "高端简洁") return "#fbfcfb";
  if (mood === "温柔亲切" || mood === "社区友好") return "#fff8ef";
  return "#f8fffb";
}

function visualMotif(payload) {
  const text = `${payload.topic || ""}${payload.contentType || ""}`;
  if (/急救|中暑|误食|呕吐|腹泻|风险/.test(text)) return "triage-alert";
  if (/体检|检查|报告|影像/.test(text)) return "clinic-report";
  if (/新手|幼|护理|到家/.test(text)) return "friendly-care";
  return "doctor-education";
}

function mockVisualStyle(payload, config, fallbackReason = "") {
  const brand = payload.brand || {};
  const visual = payload.visual || {};
  const imagePlan = imageGenerationSettings(payload);
  const primary = brand.primaryColor || visual.primary || "#18835f";
  const secondary = brand.secondaryColor || visual.secondary || "#72b7df";
  const mood = brand.mood || visual.mood || "专业可信";
  const sceneStyle = payload.sceneStyle || visual.style || "doctor";
  const motif = visualMotif(payload);
  const styleName = `${brand.hospital || "宠物医院"} · ${mood}视觉方案`;
  const prompt = buildVisualPrompt(payload);
  return {
    source: fallbackReason ? "local-visual-planner" : `image-plan:${config.image.model}`,
    configured: Boolean(config.image.apiKey && config.image.baseUrl),
    fallbackReason,
    styleName,
    motif,
    sceneStyle,
    mood,
    prompt,
    imageRequest: imagePlan,
    palette: {
      primary,
      secondary,
      background: visualBackgroundFor(mood, sceneStyle),
      ink: sceneStyle === "premium" ? "#151d1b" : "#17211f",
      accent: secondary
    },
    composition: [
      "封面保留大标题强对比区，副标题控制在两行内",
      "中间页按症状判断、避坑、医生建议、总结等不同版式分配信息",
      "底部固定医生提示安全区，避免正文和页码重叠"
    ],
    assetPlan: [
      "image2.0 按页生成最终知识卡片",
      "DeepSeek 文案经运营或医生确认后再进入出图",
      "Logo 和品牌色来自医院品牌档案"
    ],
    layoutGuards: [
      "不直接生成小字",
      "不把医疗结论画成承诺式广告",
      "导出前继续走医生审核和合规检查"
    ],
    template: {
      name: styleName,
      sub: `${mood} · ${sceneStyle}`,
      primary,
      secondary,
      mood,
      style: sceneStyle,
      visualPrompt: prompt
    }
  };
}

function imageGenerationSettings(payload) {
  const plan = payload.imageModelPlan || {};
  const referenceImages = Array.isArray(plan.referenceImages)
    ? plan.referenceImages.filter(Boolean).slice(0, 16)
    : [];
  return {
    size: plan.size || "3:4",
    resolution: plan.resolution || "1k",
    n: 1,
    officialFallback: Boolean(plan.officialFallback),
    referenceImages
  };
}

async function generateWithImageModel(payload) {
  const config = await readAiConfig();
  if (payload.imageModelPlan?.forceLocal) {
    return mockVisualStyle(payload, config, "本地模式下生成可复用视觉方案草案。");
  }
  if (!config.image.apiKey || !config.image.baseUrl) {
    return mockVisualStyle(payload, config, "image2.0 未配置，已生成可复用的视觉方案草案。");
  }
  const prompt = buildVisualPrompt(payload);
  const imagePlan = imageGenerationSettings(payload);
  const requestBody = {
    model: config.image.model,
    prompt,
    n: imagePlan.n,
    size: imagePlan.size,
    resolution: imagePlan.resolution
  };
  if (imagePlan.referenceImages.length) requestBody.image_urls = imagePlan.referenceImages;
  if (imagePlan.officialFallback) requestBody.official_fallback = true;
  const timeout = withTimeout(35000);
  let response;
  try {
    response = await fetch(`${config.image.baseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.image.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: timeout.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Image API 超时：APIMart 提交任务超过 35 秒未响应，请稍后重试。");
      timeoutError.transient = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    timeout.clear();
  }
  if (!response.ok) {
    throw externalError("Image API", response.status, await readShortText(response));
  }
  const data = await response.json();
  const image = data.data?.[0] || {};
  const taskId = image.task_id || image.taskId || "";
  if (taskId) {
    return {
      ...mockVisualStyle(payload, config),
      source: `image-task:${config.image.model}`,
      configured: true,
      adapter: "apimart-gpt-image-2-async",
      taskId,
      taskStatus: image.status || "submitted",
      imageRequest: imagePlan,
      taskEndpoint: `/api/visual-style/tasks/${encodeURIComponent(taskId)}`,
      prompt
    };
  }
  return {
    ...mockVisualStyle(payload, config),
    source: `image-model:${config.image.model}`,
    configured: true,
    adapter: "openai-compatible-images-sync",
    imageRequest: imagePlan,
    referenceImage: {
      url: image.url || "",
      b64Json: image.b64_json ? "[base64 omitted]" : ""
    },
    prompt
  };
}

async function queryImageTask(taskId) {
  const config = await readAiConfig();
  if (!config.image.apiKey || !config.image.baseUrl) {
    throw new Error("image2.0 未配置 API Key 或 Base URL");
  }
  const timeout = withTimeout(15000);
  let response;
  try {
    response = await fetch(`${config.image.baseUrl.replace(/\/$/, "")}/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        authorization: `Bearer ${config.image.apiKey}`
      },
      signal: timeout.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        taskId,
        status: "processing",
        progress: 0,
        images: [],
        error: "Task API 查询超时：APIMart 暂时未返回任务状态，请稍后检查进度。"
      };
    }
    throw error;
  } finally {
    timeout.clear();
  }
  if (!response.ok) {
    const raw = await readShortText(response);
    const error = externalError("Task API", response.status, raw);
    if (error.transient) {
      return {
        taskId,
        status: "processing",
        progress: 0,
        images: [],
        error: error.message
      };
    }
    throw error;
  }
  const body = await response.json();
  const data = body.data || {};
  const images = Array.isArray(data.result?.images)
    ? data.result.images.flatMap(item => Array.isArray(item.url) ? item.url : item.url ? [item.url] : [])
    : [];
  return {
    taskId: data.id || taskId,
    status: data.status || "processing",
    progress: Number(data.progress || 0),
    created: data.created,
    completed: data.completed,
    actualTime: data.actual_time,
    estimatedTime: data.estimated_time,
    cost: data.cost,
    images,
    expiresAt: data.result?.images?.[0]?.expires_at || "",
    error: data.error?.message || data.error || ""
  };
}

async function generateWithModel(payload) {
  const config = await readAiConfig();
  if (!config.text.apiKey) {
    return null;
  }
  let data;
  try {
    data = await fetchJsonWithDeadline(`${config.text.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.text.apiKey}`
      },
      body: JSON.stringify({
        model: config.text.model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt(payload) }
        ]
      })
    }, textGenerationTimeoutMs, `Text API 超时：DeepSeek 超过 ${Math.round(textGenerationTimeoutMs / 1000)} 秒未响应，已使用本地兜底文案。`, "Text API");
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(error.message);
    }
    throw error;
  }
  const content = data.choices?.[0]?.message?.content;
  return normalizeModelNote(extractJson(content), payload, config);
}

async function generateTopicsWithModel(payload) {
  const config = await readAiConfig();
  if (!config.text.apiKey) {
    return null;
  }
  let data;
  try {
    data = await fetchJsonWithDeadline(`${config.text.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.text.apiKey}`
      },
      body: JSON.stringify({
        model: config.text.model,
        temperature: 0.75,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: topicSystemPrompt() },
          { role: "user", content: topicUserPrompt(payload) }
        ]
      })
    }, topicGenerationTimeoutMs, `Text API 超时：DeepSeek 超过 ${Math.round(topicGenerationTimeoutMs / 1000)} 秒未响应，已使用本地推荐选题。`, "Topic API");
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(error.message);
    }
    throw error;
  }
  const content = data.choices?.[0]?.message?.content;
  return normalizeTopicRecommendations(extractJson(content), payload, config);
}

async function handleGenerate(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    let note;
    let fallbackReason = "";
    try {
      note = await generateWithModel(payload);
    } catch (error) {
      fallbackReason = error.message;
      console.warn("Model generation failed, falling back to mock:", error.message);
    }
    if (!note) {
      note = {
        ...generateNote(payload),
        fallbackReason
      };
    }
    json(res, 200, note);
  } catch (error) {
    json(res, 400, { error: "Invalid request", detail: error.message });
  }
}

async function handleRecommendTopics(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    let result;
    try {
      result = await generateTopicsWithModel(payload);
    } catch (error) {
      console.warn("Topic recommendation failed, falling back to local:", error.message);
      result = {
        ...generateTopicRecommendations(payload),
        fallbackReason: error.message
      };
    }
    if (!result) {
      result = generateTopicRecommendations(payload);
    }
    json(res, 200, result);
  } catch (error) {
    json(res, 400, { error: "Invalid topic recommendation request", detail: error.message });
  }
}

async function handleGenerateVisualStyle(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const requireImage = Boolean(payload.imageModelPlan?.requireImage);
    let plan;
    try {
      plan = await generateWithImageModel(payload);
    } catch (error) {
      if (requireImage) {
        if (error.transient) {
          json(res, 200, {
            source: "image-temporary-error",
            configured: true,
            taskStatus: "timeout",
            transient: true,
            error: error.message,
            fallbackReason: error.message,
            imageRequest: imageGenerationSettings(payload),
            prompt: buildVisualPrompt(payload)
          });
          return;
        }
        json(res, 200, {
          source: "image-error",
          configured: true,
          taskStatus: "failed",
          error: error.message,
          fallbackReason: error.message,
          prompt: buildVisualPrompt(payload)
        });
        return;
      }
      const config = await readAiConfig();
      plan = mockVisualStyle(payload, config, `image2.0 调用失败，已回退：${error.message}`);
    }
    if (requireImage && !plan.taskId && !plan.referenceImage?.url) {
      json(res, 200, {
        ...plan,
        taskStatus: "failed",
        error: plan.fallbackReason || "image2.0 未返回任务或图片"
      });
      return;
    }
    json(res, 200, plan);
  } catch (error) {
    json(res, 400, { error: "Invalid visual request", detail: error.message });
  }
}

async function handleGetVisualTask(res, taskId) {
  try {
    json(res, 200, await queryImageTask(taskId));
  } catch (error) {
    json(res, 200, {
      taskId,
      status: error.transient ? "processing" : "failed",
      progress: 0,
      images: [],
      error: error.message
    });
  }
}

async function handleImageProxy(res, targetUrl) {
  try {
    const parsed = new URL(String(targetUrl || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      json(res, 400, { error: "Invalid image URL" });
      return;
    }
    const response = await fetch(parsed);
    if (!response.ok) {
      json(res, response.status, { error: "Image fetch failed", detail: await response.text() });
      return;
    }
    const image = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "content-type": response.headers.get("content-type") || "image/png",
      "cache-control": "private, max-age=3600",
      "access-control-allow-origin": "*"
    });
    res.end(image);
  } catch (error) {
    json(res, 400, { error: "Invalid image proxy request", detail: error.message });
  }
}

async function handleGetAiConfig(res) {
  try {
    json(res, 200, publicAiConfig(await readAiConfig()));
  } catch (error) {
    json(res, 500, { error: "Failed to read AI config", detail: error.message });
  }
}

async function handleSaveAiConfig(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const saved = await writeAiConfig(payload);
    json(res, 200, publicAiConfig(saved));
  } catch (error) {
    json(res, 400, { error: "Invalid AI config", detail: error.message });
  }
}

async function handleCreateReview(req, res) {
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload.deck || !Array.isArray(payload.deck.cards)) {
      json(res, 400, { error: "Invalid review request", detail: "deck.cards is required" });
      return;
    }
    const review = await upsertReviewRecord({
      id: payload.id,
      status: "pending",
      reviewer: "",
      overall: "",
      comments: {},
      style: payload.style,
      visualPlan: payload.visualPlan || payload.deck.visualPlan || null,
      deck: payload.deck
    });
    json(res, 200, { review });
  } catch (error) {
    json(res, 400, { error: "Invalid review request", detail: error.message });
  }
}

async function handleGetReview(req, res, id) {
  try {
    const review = await getReviewRecord(id);
    if (!review) {
      json(res, 200, { review: null });
      return;
    }
    json(res, 200, { review });
  } catch (error) {
    json(res, 500, { error: "Failed to read review", detail: error.message });
  }
}

async function handleSubmitReview(req, res, id) {
  try {
    const existing = await getReviewRecord(id);
    if (!existing) {
      json(res, 404, { error: "Review not found" });
      return;
    }
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const status = ["approved", "changes"].includes(payload.status) ? payload.status : "";
    if (!status) {
      json(res, 400, { error: "Invalid review status" });
      return;
    }
    const review = await upsertReviewRecord({
      ...existing,
      status,
      reviewer: payload.reviewer || "未署名医生",
      overall: payload.overall || "",
      comments: cleanComments(payload.comments),
      submittedAt: new Date().toISOString(),
      deck: existing.deck
    });
    json(res, 200, { review });
  } catch (error) {
    json(res, 400, { error: "Invalid review submission", detail: error.message });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "public, max-age=86400" });
    res.end();
    return;
  }
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(root, decodeURIComponent(pathname));
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }
  if (url.pathname === "/api/health") {
    const config = await readAiConfig();
    json(res, 200, {
      ok: true,
      ...publicAiConfig(config),
      reviewStore: reviewStorePath
    });
    return;
  }
  if (url.pathname === "/api/ai-config" && req.method === "GET") {
    await handleGetAiConfig(res);
    return;
  }
  if (url.pathname === "/api/ai-config" && req.method === "POST") {
    await handleSaveAiConfig(req, res);
    return;
  }
  if (url.pathname === "/api/xhs-notes/generate" && req.method === "POST") {
    await handleGenerate(req, res);
    return;
  }
  if (url.pathname === "/api/topics/recommend" && req.method === "POST") {
    await handleRecommendTopics(req, res);
    return;
  }
  if (url.pathname === "/api/visual-style/generate" && req.method === "POST") {
    await handleGenerateVisualStyle(req, res);
    return;
  }
  const visualTaskMatch = url.pathname.match(/^\/api\/visual-style\/tasks\/([^/]+)$/);
  if (visualTaskMatch && req.method === "GET") {
    await handleGetVisualTask(res, decodeURIComponent(visualTaskMatch[1]));
    return;
  }
  if (url.pathname === "/api/image-proxy" && req.method === "GET") {
    await handleImageProxy(res, url.searchParams.get("url") || "");
    return;
  }
  if (url.pathname === "/api/reviews" && req.method === "POST") {
    await handleCreateReview(req, res);
    return;
  }
  const submitMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/submit$/);
  if (submitMatch && req.method === "POST") {
    await handleSubmitReview(req, res, decodeURIComponent(submitMatch[1]));
    return;
  }
  const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewMatch && req.method === "GET") {
    await handleGetReview(req, res, decodeURIComponent(reviewMatch[1]));
    return;
  }
  await handleStatic(req, res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`程程宠物医院工作台: http://127.0.0.1:${port}/`);
});
