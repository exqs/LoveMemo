// 浏览器预览用的模拟 AI 输出。只在没有 Tauri 的环境里使用，桌面版不会走到这里。
import type { AiTask, ChatLine, Message, QuizKind, Rule } from '../lib/types'
import { SAMPLE_MESSAGES, SAMPLE_SCREENSHOT_SPLITS } from '../fixtures/sample1122'

type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const SAMPLE_ANALYSIS = {
  summary: '她认真分享"建文件夹"的帖子，我用玩笑带过，之后连续追问和反问，她认为我又在敷衍、不先说想法。',
  timeline: [
    { msg: 'm4', note: '她认真分享，我用"阿巴阿巴"带过' },
    { msg: 'm8', note: '我开始连续追问"啥意思"，把解释的责任推给她' },
    { msg: 'm25', note: '我反问"这什么态度"，情绪升级' },
    { msg: 'm31', note: '我反过来问她为什么不问我在想什么' },
    { msg: 'm38', note: '我才说出知识库的想法' },
    { msg: 'm48', note: '我解释"在想怎么实现"，她认为是狡辩' },
  ],
  her_words: [
    { quote: '不在乎 随口敷衍几句', msg: 'm26' },
    { quote: '你有什么想说的，大可以说', msg: 'm34' },
    { quote: '而不是敷衍几句', msg: 'm35' },
    { quote: '你想什么先说', msg: 'm55' },
    { quote: '我说了无数遍', msg: 'm57' },
    { quote: '下一次我问你建了么，你说没有呢，忙啥啥了', msg: 'm27' },
  ],
  inferences: ['她分享帖子，是想看到我被触动、有自己的打算，而不是一句玩笑。', '她更在意"我愿不愿意主动说"，而不是我最后想出了什么方案。'],
  misses: [
    { msg: 'm4', problem: '她认真分享，我用"阿巴阿巴"带过，她读到的是不当回事' },
    { msg: 'm8', problem: '"啥意思呀""我没明白"连续追问，让她来解释自己为什么不高兴' },
    { msg: 'm25', problem: '"这什么态度呀"是反问，把矛头转向了她' },
    { msg: 'm31', problem: '心里有想法却不说，反而怪她不问' },
    { msg: 'm47', problem: '被问为什么不说时先解释原因，她听到的是辩解' },
  ],
  next_time: [
    { action: '她分享和我们有关的东西，先说真实感受，再说打算，没想好也先说半成品', say: '这个男生好用心，我也想做一个，我先想想怎么弄，今晚给你看。' },
    { action: '她不高兴时，先认下能确定的那部分，不让她解释', say: '我刚才那句回得太随便了。' },
    { action: '被指出问题时先认，不解释原因', say: '你说得对，我应该一开始就说。' },
  ],
  commitments: [{ content: '把知识库做出来', due_hint: '下午' }],
  tags: ['敷衍回应', '没先说想法', '反问追问', '解释辩解'],
  new_tags: [],
  severity: 4,
}

function genericAnalysis(msgs: Message[]) {
  const mine = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.speaker === 'me')
  const hers = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.speaker === 'them' && x.m.content.length >= 2)
  return {
    summary: '（预览模式的模拟复盘）她表达了不满，我的回应没有先接住她的情绪。',
    timeline: hers.slice(0, 3).map((x) => ({ msg: 'm' + (x.i + 1), note: '她表达不满' })),
    her_words: hers.slice(0, 3).map((x) => ({ quote: x.m.content, msg: 'm' + (x.i + 1) })),
    inferences: ['她可能希望我先回应她的感受。'],
    misses: mine.slice(0, 2).map((x) => ({ msg: 'm' + (x.i + 1), problem: '没有先回应她的情绪' })),
    next_time: [{ action: '先回应感受，再说事情', say: '听起来你挺失望的，是我刚才那样让你不舒服了。' }],
    commitments: [], tags: ['没共情'], new_tags: [], severity: 3,
  }
}

const QUIZ: Record<QuizKind, Any> = {
  why: {
    scenario_key: '分享帖子被玩笑带过', prompt: '她为什么最后说"算了"？说出你认为她在意的点。',
    chat: [
      { speaker: 'them', content: '你看这个，好用心的男朋友' }, { speaker: 'me', content: '哈哈哈哈' },
      { speaker: 'them', content: '就哈哈？' }, { speaker: 'me', content: '那你想让我说啥呀' }, { speaker: 'them', content: '算了' },
    ],
    options: [], rubric: ['她分享是想听我的想法和打算', '"那你想让我说啥"把责任推给了她'], reference: '她想看到我被触动、主动说"我也想为你做点什么"。我先笑过去，又反问她，等于让她自己把期待说出口。',
  },
  choose: {
    scenario_key: '她发来情侣攒钱计划', prompt: '她发来这条消息，哪个回复最好？',
    chat: [{ speaker: 'them', content: '[小红书] 情侣一起攒钱的 52 周计划' }, { speaker: 'them', content: '好有意思' }],
    options: ['哈哈哈', '你想攒钱呀？', '这个挺好，我们也试试？我先算算每周存多少，晚上发你', '你又在刷小红书'],
    answer_index: 2, rubric: ['先回应她分享的内容', '主动说出自己的打算', '给出具体时间'], reference: '这个挺好，我们也试试？我先算算每周存多少，晚上发你',
  },
  rewrite: {
    scenario_key: '她说心寒了', prompt: '把最后一句"我"的话改得更好。',
    chat: [{ speaker: 'them', content: '你的态度' }, { speaker: 'them', content: '心寒了' }, { speaker: 'me', content: '啊？这什么态度呀，用词不准确还是什么' }],
    options: [], rubric: ['先认，不反问', '说出自己具体哪里做得不好'], reference: '我刚才那几句回得很随便，你认真分享，我却在开玩笑，难怪你心寒。',
  },
  spot: {
    scenario_key: '答应的事被问进度', prompt: '哪一句"我"说的话最让她不高兴？',
    chat: [
      { speaker: 'them', content: '你说的那个做了吗' }, { speaker: 'me', content: '还没呢' },
      { speaker: 'them', content: '为什么' }, { speaker: 'me', content: '这两天太忙了，下周吧' }, { speaker: 'them', content: '哦' },
    ],
    spot_index: 3, options: [], rubric: ['承诺没兑现时先认', '给出新的具体时间并主动汇报'], reference: '是我拖了，没提前跟你说。今晚我先做一半给你看，周三前做完。',
  },
  roleplay: {
    scenario_key: '分享帖子后的开场', prompt: '她刚给你发了一个"男朋友记录吵架笔记"的帖子。回她。',
    chat: [{ speaker: 'them', content: '[小红书] 好具象的爱啊' }], options: [], rubric: ['先说真实感受', '说自己的打算', '不用玩笑带过'], reference: '',
  },
}

export function mockReply(task: AiTask, data: unknown, plain = false): unknown {
  const d = (data ?? {}) as Any
  if (plain) return `（预览模式）你提的说法方向是对的。可以再具体一点：说清楚你哪一句没做好，再给一个具体时间。比如"我刚才回得太随便了，今晚把想法整理好发你"。`
  switch (task) {
    case 'recognize': {
      const total = d.total ?? 1
      const splits = SAMPLE_SCREENSHOT_SPLITS
      if (total === splits.length) { const [a, b] = splits[d.index]; return { messages: SAMPLE_MESSAGES.slice(a, b) } }
      const per = Math.ceil(SAMPLE_MESSAGES.length / total)
      return { messages: SAMPLE_MESSAGES.slice(d.index * per, (d.index + 1) * per) }
    }
    case 'analyze': {
      const msgs = (d.msgs ?? []) as Message[]
      const isSample = msgs.length === SAMPLE_MESSAGES.length && msgs[2]?.content === SAMPLE_MESSAGES[2].content
      return isSample ? SAMPLE_ANALYSIS : genericAnalysis(msgs)
    }
    case 'match': {
      const rules = (d.rules ?? []) as Rule[]
      const bad = (d.myBad ?? []) as string[]
      if (rules.length) return { decisions: [{ action: 'attach', rule_id: rules[0].id, reason: '（预览）和这条是同一类问题', tags: [] }] }
      return {
        decisions: [
          { action: 'create', title: '她分享和我们有关的东西时，先说真实感受和打算', trigger_scene: '她发来帖子、视频、别人的故事', good_example: '这个好用心，我也想做一个，今晚给你看。', bad_example: bad[0] ?? '阿巴阿巴', reason: '', tags: ['敷衍回应', '没先说想法'] },
          { action: 'create', title: '她不高兴时先认，不追问、不反问、不解释', trigger_scene: '她说"睡了""就这样吧""你的态度"', good_example: '我刚才那句回得太随便了。', bad_example: bad[2] ?? '啊？这什么态度呀', reason: '', tags: ['反问追问', '解释辩解'] },
        ],
      }
    }
    case 'quiz': return { kind: d.kind, ...QUIZ[(d.kind as QuizKind) ?? 'why'] }
    case 'grade': {
      const q = d.q as Any | undefined
      return {
        score: 76, good: ['先回应了她说的内容'], problems: ['可以更具体地说出自己哪一句做得不好'],
        reference: q?.reference ?? '', option_notes: q?.kind === 'choose' ? ['只用笑带过，等于没回应', '反问把话题推回给她', '回应了内容，说了打算，给了时间', '带一点指责'] : [],
      }
    }
    case 'roleplay': {
      const h = (d.history ?? []) as ChatLine[]
      if (d.review) return { score: 74, summary: '（预览）开头接住了她的分享，中间有一句解释原因，后面认得及时。', line_notes: h.filter((x) => x.speaker === 'me').slice(0, 2).map((x) => ({ line: x.content, note: '方向对，可以再具体一点' })), reference: '这个男生好用心，我也想为你做一个。' }
      const n = h.filter((x) => x.speaker === 'me').length
      const replies = ['就这？', '那你打算怎么做', '嗯，那你说说看', '好吧，那今晚给我看']
      return { her_reply: replies[Math.min(n - 1, 3)] ?? '嗯', coach_tip: n < 2 ? '先说你的真实感受，别急着问她想要什么' : '很好，再给一个具体时间', resolved: n >= 4, mood: Math.min(5, 1 + n) }
    }
    default: return { summary: '（预览）本周新增 1 条便签，"先说想法"这一条重复了两次。', focus: '她分享东西时，先说一句真实感受。', ok: true }
  }
}
