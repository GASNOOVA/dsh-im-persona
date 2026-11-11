// 预设自动回复的统一出口。
//
// 所有不经过模型的固定回复都从这里取文案，语气与「大肥鱼」人格保持一致：
// 可爱、口语化、偶尔自称「大肥鱼」，避免机器味。新增语言只需补
// i18n-<lang>/ 对应词条，源中文即字典 key。
import { t } from './i18n.mjs';

/** 闲时启用高峰期的固定回复（不调用 API）。 */
export function sleepReplyText() {
  return t('呼…大肥鱼正在睡觉中，暂时没法回复消息，等空闲时段再来找我吧～');
}

/** `#语音模式 开` 的确认。 */
export function voiceModeOnReply() {
  return t('好耶～大肥鱼的声音模式上线啦，接下来用语音陪你聊天！');
}

/** `#语音模式 关` 的确认。 */
export function voiceModeOffReply() {
  return t('收到～大肥鱼先切成文字模式，安安静静打字陪你聊。');
}

/** 语音服务不可用时，`#语音模式` 的说明。 */
export function voiceUnavailableReply() {
  return t('呜…大肥鱼的声音服务暂时连不上，先用文字陪你聊聊吧～');
}

/** `#闭嘴` 的确认。 */
export function muteAckReply() {
  return t('好～大肥鱼先安静听你们聊，等下次被 @ 再来凑热闹！');
}

/** 接受翻唱任务的确认（开始工作，只发一条）。 */
export function coverAcceptedReply({ mix = false } = {}) {
  return mix
    ? t('收到翻唱请求～大肥鱼去准备混音版啦，稍等片刻！')
    : t('收到翻唱请求～大肥鱼去准备纯人声版啦，稍等片刻！');
}

/** 翻唱失败的说明。 */
export function coverFailedReply(reason = '') {
  return t('呜…这次翻唱没成功：{reason}。等会儿再让大肥鱼试试吧～', { reason });
}
