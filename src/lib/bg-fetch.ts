import { createLimiter } from "./request-gate";

/**
 * 后台请求专用 fetch（P41）：全站共用一个闸门，同时最多 2 个在途，
 * 另外 4 条连接留给「点词查词典 / 收词 / AI 讲解」这类用户正在等的请求。
 *
 * 响应体在闸门内读完再还给调用方：body 不读完，keep-alive 连接不会归还连接池
 * （P40 实测过），所以这里统一处理，调用方照常 res.json() / res.ok 即可。
 * 用途：进度上报、批注刷新、做卡状态、学习档案开关、已保存的回答。
 */
const limit = createLimiter(2);

const NO_BODY = new Set([204, 205, 304]);

export function bgFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return limit(async () => {
    const res = await fetch(input, init);
    const buf = await res.arrayBuffer();
    return new Response(NO_BODY.has(res.status) ? null : buf, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  });
}
