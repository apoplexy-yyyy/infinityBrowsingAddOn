const VIEWER = chrome.runtime.getURL('viewer.html');

chrome.action.onClicked.addListener((tab) => {
  if (!/^https?:/.test(tab.url || '')) return;
  chrome.tabs.update(tab.id, { url: `${VIEWER}?url=${encodeURIComponent(tab.url)}` });
});

// ビューアが追加したヘッダー除去ルールは、そのタブを離れたら残さない
function removeRule(tabId) {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
}

chrome.tabs.onRemoved.addListener(removeRule);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && !changeInfo.url.startsWith(VIEWER)) removeRule(tabId);
});
