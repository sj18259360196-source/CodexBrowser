const status = document.querySelector("#status");
const pair = document.querySelector("#pair");
const disconnect = document.querySelector("#disconnect");
async function refresh() {
  const value = await chrome.runtime.sendMessage({ type: "status" });
  if (!value?.paired) status.textContent = value?.error ? `未连接：${value.error}` : "尚未配对";
  else status.textContent = value.error ? `已配对，等待 broker：${value.error}` : `已连接 · ${value.connectedAt || "正在建立连接"}`;
  pair.hidden = Boolean(value?.paired); disconnect.hidden = !value?.paired;
}
pair.addEventListener("click", async () => { pair.disabled = true; const value = await chrome.runtime.sendMessage({ type: "pair" }); status.textContent = value?.ok ? "配对成功，正在连接…" : `配对失败：${value?.error || "未知错误"}`; pair.disabled = false; await refresh(); });
disconnect.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "disconnect" }); await refresh(); });
void refresh();
