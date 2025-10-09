//★★初回設定★★
//⚙️「プロジェクトの設定」から、スクリプトプロパティ-の設定を行う。画像を保存するフォルダIDを「DRIVE_FOLDER_ID」、Gemini APIキーを「GEMINI_API_KEY」
/**
 * @fileoverview Digital Closet アプリケーションのサーバーサイドロジックを担当します。
 * Google Apps Scriptで記述されており、スプレッドシートとのデータ連携、
 * ビジネスロジックの実行、およびGemini APIとの通信を管理します。
 */

//----------------------------------------------------------------
// グローバル定数
//----------------------------------------------------------------
const ss = SpreadsheetApp.getActiveSpreadsheet();
const dbSheet = ss.getSheetByName('データベース');
const categoryMasterSheet = ss.getSheetByName('種類番号');
const colorMasterSheet = ss.getSheetByName('色番号');
const wearLogSheet = ss.getSheetByName('着用ログ');
const coordLogSheet = ss.getSheetByName('コーディネートログ');
const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

//----------------------------------------------------------------
// Webアプリケーションのエントリーポイント
//----------------------------------------------------------------
function doGet() {
  return HtmlService.createTemplateFromFile('index').evaluate().setTitle('Digital Closet');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

//----------------------------------------------------------------
// 画像アップロード & 新規行準備
//----------------------------------------------------------------
function uploadImage(payload = {}) {
  const { fileData, fileName, itemId } = payload;
  try {
    let targetItemId = itemId;
    let isNewItem = false;

    if (!targetItemId) {
      isNewItem = true;
      const newRowIndex = dbSheet.getLastRow() + 1;
      dbSheet.insertRowAfter(newRowIndex - 1);
      dbSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
      dbSheet.getRange(newRowIndex, 2).setFormula(`=IFERROR(XLOOKUP(D${newRowIndex},'種類番号'!B:B,'種類番号'!A:A,""), "")`);
      dbSheet.getRange(newRowIndex, 3).setFormula(`=IFERROR(XLOOKUP(E${newRowIndex},'色番号'!B:B,'色番号'!A:A,""), "")`);
      dbSheet.getRange(newRowIndex, 12).setFormula(`=IF(ISBLANK(J${newRowIndex}), IF(ISBLANK(I${newRowIndex}), "", YEAR(TODAY())-I${newRowIndex}), J${newRowIndex}-I${newRowIndex})`);
      SpreadsheetApp.flush();
      targetItemId = dbSheet.getRange(newRowIndex, 1).getDisplayValue();
      if (!targetItemId) throw new Error('新しいアイテムIDの採番に失敗しました。');
    }
    
    if (fileData && FOLDER_ID) {
      const folder = DriveApp.getFolderById(FOLDER_ID);
      const contentType = fileData.substring(5, fileData.indexOf(';'));
      const bytes = Utilities.base64Decode(fileData.substring(fileData.indexOf('base64,') + 7));
      const blob = Utilities.newBlob(bytes, contentType, fileName);
      const extension = fileName.includes('.') ? fileName.split('.').pop() : 'jpg';
      const newFileName = `${targetItemId}.${extension}`;

      const existingFiles = folder.getFilesByName(newFileName);
      const file = existingFiles.hasNext() ? existingFiles.next().setContent(blob.getBytes()) : folder.createFile(blob).setName(newFileName);
      
      const result = { fileId: file.getId() };
      if (isNewItem) result.newItemId = targetItemId;
      return result;
    }
    return isNewItem ? { newItemId: targetItemId, fileId: '' } : { fileId: '' };

  } catch (e) {
    console.error(`uploadImage Error: ${e.stack}`);
    return { error: `処理中にエラーが発生しました: ${e.message}` };
  }
}

//----------------------------------------------------------------
// データ取得 (Read)
//----------------------------------------------------------------
const _cache = CacheService.getScriptCache();

function _getAllSheetValues(sheet) {
    const cacheKey = `${sheet.getParent().getId()}_${sheet.getName()}`;
    const cached = _cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return [];
    const values = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getDisplayValues();
    _cache.put(cacheKey, JSON.stringify(values), 300); // 5分キャッシュ
    return values;
}

function _invalidateCache(sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (sheet) _cache.remove(`${ss.getId()}_${sheetName}`);
}

function _getAllItemsFromSheet() {
  const values = _getAllSheetValues(dbSheet);
  if (values.length < 2) return [];
  const headers = values.shift();
  return values.map(row => headers.reduce((obj, header, i) => {
      obj[header] = row[i];
      return obj;
    }, {})
  ).filter(item => item['ID']);
}

function getItems() {
  try {
    return _getAllItemsFromSheet().filter(item => !item['廃棄年']);
  } catch (e) {
    console.error(`getItems Error: ${e.stack}`);
    return { error: 'アイテムデータの取得中にエラーが発生しました。' };
  }
}

function getDisposedItems() {
  try {
    return _getAllItemsFromSheet().filter(item => item['廃棄年']);
  } catch (e) {
    console.error(`getDisposedItems Error: ${e.stack}`);
    return { error: '廃棄済みアイテムデータの取得中にエラーが発生しました。' };
  }
}

function getOptions() {
  try {
    const getMasterData = (sheet) => {
      const values = _getAllSheetValues(sheet);
      if (values.length < 2) return [];
      return values.slice(1).map(row => ({ id: row[0], name: row[1], code: row[2] || null })).filter(item => item.id && item.name);
    };
    return {
      categories: getMasterData(categoryMasterSheet),
      colors: getMasterData(colorMasterSheet)
    };
  } catch (e) {
    console.error(`getOptions Error: ${e.stack}`);
    return { error: '選択肢データの取得中にエラーが発生しました。' };
  }
}

function getDashboardData() {
  try {
    const items = getItems();
    if (items.error) throw new Error(items.error);
    const itemsById = items.reduce((map, item) => (map[item.ID] = item, map), {});
    return {
      stats: _calculateStats(items),
      ..._calculateChartData(items),
      wearRank: _getWearRank(itemsById),
      coordinates: _getCoordinates(itemsById).reverse(),
      colorMaster: getOptions().colors
    };
  } catch (e) {
    console.error(`getDashboardData Error: ${e.stack}`);
    return { error: 'ダッシュボードデータの生成中にエラーが発生しました。' };
  }
}

function getUnwornItems() {
    try {
        const items = getItems();
        if (items.error) throw new Error(items.error);

        const wearLogValues = _getAllSheetValues(wearLogSheet);
        if (wearLogValues.length < 2) {
             return items.map(item => ({ item, wearCount: 0, lastWear: null }));
        }
        
        const wearData = wearLogValues.slice(1).reduce((acc, row) => {
            const itemId = row[1];
            const wearDate = new Date(row[2]);
            if (!acc[itemId]) acc[itemId] = { count: 0, last: new Date(0) };
            acc[itemId].count++;
            if (wearDate > acc[itemId].last) acc[itemId].last = wearDate;
            return acc;
        }, {});

        return items.map(item => ({
            item,
            wearCount: (wearData[item.ID] || {}).count || 0,
            lastWear: (wearData[item.ID] || {}).last || null
        }));
    } catch(e) {
        console.error(`getUnwornItems Error: ${e.stack}`);
        return { error: 'ご無沙汰アイテムの取得に失敗しました。' };
    }
}

function getItemDetails(itemId) {
  try {
    if (!itemId) throw new Error('アイテムIDが指定されていません。');
    const itemsById = getItems().reduce((map, item) => (map[item.ID] = item, map), {});
    const targetItem = itemsById[itemId];
    if (!targetItem) throw new Error('アイテムが見つかりません。');
    
    return {
      item: targetItem,
      coordinates: _getCoordinates(itemsById).filter(coord => coord.itemIds.includes(String(itemId))).sort((a, b) => b.rating - a.rating),
      wearData: _getWearDataForItem(itemId)
    };
  } catch (e) {
    console.error(`getItemDetails Error: ${e.stack}`);
    return { error: `アイテム詳細の取得中にエラーが発生しました: ${e.message}` };
  }
}

function getWearLogData({year, month}) {
    try {
        const itemsById = getItems().reduce((map, item) => (map[item.ID] = item, map), {});
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        const wearLogValues = _getAllSheetValues(wearLogSheet);
        if (wearLogValues.length < 2) return {};

        const logs = {};
        wearLogValues.slice(1).forEach(row => {
            const logDate = new Date(row[2]);
            if (logDate >= startDate && logDate <= endDate) {
                const dateKey = Utilities.formatDate(logDate, 'JST', 'yyyy-MM-dd');
                const item = itemsById[row[1]];
                if (item) {
                    if (!logs[dateKey]) logs[dateKey] = [];
                    logs[dateKey].push({ logId: row[0], item: item });
                }
            }
        });
        return logs;
    } catch (e) {
        console.error(`getWearLogData Error: ${e.stack}`);
        return { error: '着用カレンダーのデータ取得に失敗しました。' };
    }
}

// --- AI関連 ---
function _callGeminiAPI(prompt, isJsonOutput = false, images = []) {
  if (!API_KEY) throw new Error('Gemini APIキーがスクリプトプロティに設定されていません。');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${API_KEY}`;
  
  const parts = [{ "text": prompt }];
  if (images && images.length > 0) {
      images.forEach(image => parts.push({"inline_data": {"mime_type": image.mimeType, "data": image.base64}}));
  }

  const payload = { "contents": [{ "parts": parts }] };
  if (isJsonOutput) {
    payload.generation_config = { "response_mime_type": "application/json" };
  }
  
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload) };
  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());

  if (result.candidates && result.candidates[0].content) {
    let text = result.candidates[0].content.parts[0].text;
    if (isJsonOutput) {
       text = text.replace(/```json/g, '').replace(/```/g, '').trim();
       return JSON.parse(text);
    }
    return text;
  }
  console.error("Gemini API response format error: ", JSON.stringify(result));
  throw new Error('AIからの応答を解析できませんでした。');
}

function getStyleSuggestion({ baseItemId, customRequest }) {
  try {
    const { allItems, itemsById, favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const baseItem = itemsById[baseItemId];
    if (!baseItem) throw new Error('基準となるアイテムが見つかりません。');
    
    const baseItemForPrompt = `ID: ${baseItem.ID}, Name: ${baseItem['名前']}, Category: ${baseItem['種類']}, Color: ${baseItem['色']}, Season: ${baseItem['着用シーズン'] || '未設定'}, Formality: ${baseItem['フォーマル度'] || '未設定'}`;
    
    const prompt = `あなたは私の好みを深く理解したプロのファッションスタイリストです。以下の情報を元に、「基準アイテム」に合うコーディネートを最大3つ提案してください。
提案は必ず「手持ちの服リスト」内のアイテムから選び、結果は有効なJSON配列としてのみ出力してください。各コーデは "item_ids" と "reason" をキーに持つオブジェクトとします。
${customRequest ? `# 要望\n- ${customRequest.trim()}\n` : ''}${favoriteCoordsPrompt}
# 手持ちの服リスト\n${wardrobeForPrompt}
# 基準アイテム\n${baseItemForPrompt}`;

    const suggestions = _callGeminiAPI(prompt, true);
    return { suggestions: suggestions.map(coord => ({
        items: coord.item_ids.map(id => allItems.find(item => item.ID == id)).filter(Boolean),
        reason: coord.reason
    }))};
  } catch (e) {
    console.error(`getStyleSuggestion Error: ${e.stack}`);
    return { error: `提案の生成中にエラーが発生しました: ${e.message}` };
  }
}

function analyzeImagesWithAI(images) {
  try {
    const optionsData = getOptions();
    if (optionsData.error) throw new Error(optionsData.error);
    const prompt = `提供された画像を分析し、衣類アイテムの情報を抽出してください。
「種類」は[${optionsData.categories.map(c => c.name).join(', ')}]から、
「色」は[${optionsData.colors.map(c => c.name).join(', ')}]から選んでください。
「着用シーズン」は["春", "夏", "秋", "冬"]の配列、「フォーマル度」は1～5の数値で回答してください。
不明な項目は空文字 "" または空の配列 [] としてください。
返答は以下のJSONスキーマに従ってください:
{"type": "OBJECT", "properties": {"名前": {"type": "STRING"}, "種類": {"type": "STRING"}, "色": {"type": "STRING"}, "素材": {"type": "STRING"}, "柄": {"type": "STRING"}, "着用シーズン": {"type": "ARRAY", "items": {"type": "STRING"}}, "フォーマル度": {"type": "NUMBER"}, "メモ": {"type": "STRING"}}}`;
    
    const itemData = _callGeminiAPI(prompt, true, images);
    return { data: itemData };
  } catch (e) {
    console.error(`analyzeImagesWithAI Error: ${e.stack}`);
    return { error: `画像解析中にエラーが発生しました: ${e.message}` };
  }
}

function getAiConsultation({ userQuestion, images }) {
  try {
    const { favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const prompt = `あなたは私の専属ファッションスタイリストです。以下の情報を参考に、私の質問に具体的かつ簡潔に回答してください。挨拶や前置き、結びの言葉は不要です。私のワードローブのアイテムを提案する場合は「ID:〇〇」と明記してください。
# 私のワードローブ\n${wardrobeForPrompt}\n${favoriteCoordsPrompt}
---
# 私からの質問\n${userQuestion}`;

    const answer = _callGeminiAPI(prompt, false, images);
    return { answer };
  } catch (e) {
    console.error(`getAiConsultation Error: ${e.stack}`);
    return { error: `AIへの相談中にエラーが発生しました: ${e.message}` };
  }
}


//----------------------------------------------------------------
// データ更新 (Create/Update/Delete)
//----------------------------------------------------------------
function saveItem(itemData) {
  try {
    const headers = _getAllSheetValues(dbSheet)[0];
    const formulaColumns = ['ID', '種類番号', '色番号', '着用年数'];
    const dataToWrite = { ...itemData };
    dataToWrite['種類'] = masterIdToName(itemData['種類番号'], categoryMasterSheet);
    dataToWrite['色'] = masterIdToName(itemData['色番号'], colorMasterSheet);

    const range = dbSheet.getRange("A:A").createTextFinder(String(itemData.id)).findNext();
    if (!range) throw new Error('指定されたIDのアイテムが見つかりません。');
    const targetRow = range.getRow();

    const rowValues = headers.map(header => {
      if (formulaColumns.includes(header)) return dbSheet.getRange(targetRow, headers.indexOf(header) + 1).getFormula() || null;
      return dataToWrite[header] !== undefined ? dataToWrite[header] : null;
    });
    
    dbSheet.getRange(targetRow, 1, 1, headers.length).setValues([rowValues]);
    _invalidateCache('データベース');
    return { status: 'success', message: 'アイテムを更新しました。' };
  } catch (e) {
    console.error(`saveItem Error: ${e.stack}`);
    return { status: 'error', message: `保存に失敗しました: ${e.message}` };
  }
}

function _findRowByIdAndSetColumn(sheet, id, headerName, value, cacheNameToInvalidate) {
    const headers = _getAllSheetValues(sheet)[0];
    const colIndex = headers.indexOf(headerName);
    if (colIndex === -1) throw new Error(`${headerName}列が見つかりません。`);
    
    const range = sheet.getRange("A:A").createTextFinder(String(id)).findNext();
    if (!range) throw new Error('指定されたIDが見つかりません。');
    
    sheet.getRange(range.getRow(), colIndex + 1).setValue(value);
    if(cacheNameToInvalidate) _invalidateCache(cacheNameToInvalidate);
}

function deleteItem(id) {
    try {
        _findRowByIdAndSetColumn(dbSheet, id, '廃棄年', new Date(), 'データベース');
        return { status: 'success', message: 'アイテムを廃棄済みにしました。' };
    } catch (e) {
        console.error(`deleteItem Error: ${e.stack}`);
        return { status: 'error', message: e.message };
    }
}

function restoreItem(id) {
    try {
        _findRowByIdAndSetColumn(dbSheet, id, '廃棄年', '', 'データベース');
        return { status: 'success', message: 'アイテムを元に戻しました。' };
    } catch (e) {
        console.error(`restoreItem Error: ${e.stack}`);
        return { status: 'error', message: e.message };
    }
}

function logWear(itemId) {
  try {
    const newRowIndex = wearLogSheet.getLastRow() + 1;
    wearLogSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
    wearLogSheet.getRange(newRowIndex, 2, 1, 2).setValues([[itemId, new Date()]]);
    _invalidateCache('着用ログ');
    return { status: 'success', message: '着用を記録しました！' };
  } catch (e) {
    console.error(`logWear Error: ${e.stack}`);
    return { status: 'error', message: '着用記録に失敗しました。' };
  }
}

function saveCoordinate({ itemIds, rating, reason, coordId }) {
  try {
    if (!itemIds || itemIds.length === 0) throw new Error('アイテムが選択されていません。');
    const sortedIds = [...itemIds].sort((a, b) => a - b).join(',');

    if (coordId) {
      const range = coordLogSheet.getRange("A:A").createTextFinder(String(coordId)).findNext();
      if (!range) throw new Error('指定されたIDのコーデが見つかりません。');
      coordLogSheet.getRange(range.getRow(), 2).setValue(sortedIds);
      if (rating !== undefined) coordLogSheet.getRange(range.getRow(), 3).setValue(rating);
      if (reason !== undefined) coordLogSheet.getRange(range.getRow(), 5).setValue(reason);
      _invalidateCache('コーディネートログ');
      return { status: 'success', message: 'コーディネートを更新しました！' };
    }
    
    const lastRow = coordLogSheet.getLastRow();
    if (lastRow > 1) {
      const existingCoords = coordLogSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
      if (existingCoords.some(c => String(c).split(',').sort((a, b) => a - b).join(',') === sortedIds)) {
        return { status: 'error', message: '同じ組み合わせのコーデが既に保存されています。' };
      }
    }
    
    const newRowIndex = lastRow + 1;
    coordLogSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
    coordLogSheet.getRange(newRowIndex, 2, 1, 4).setValues([[sortedIds, (rating || ''), new Date(), (reason || '')]]);
    _invalidateCache('コーディネートログ');
    return { status: 'success', message: 'コーディネートを保存しました！' };
  } catch (e) {
    console.error(`saveCoordinate Error: ${e.stack}`);
    return { status: 'error', message: 'コーディネートの保存に失敗しました。' };
  }
}

function deleteCoordinate(coordId) {
    try {
        const range = coordLogSheet.getRange("A:A").createTextFinder(String(coordId)).findNext();
        if (!range) throw new Error('指定されたIDのコーデが見つかりません。');
        coordLogSheet.deleteRow(range.getRow());
        _invalidateCache('コーディネートログ');
        return { status: 'success', message: 'コーデを削除しました。' };
    } catch (e) {
        console.error(`deleteCoordinate Error: ${e.stack}`);
        return { status: 'error', message: 'コーデの削除に失敗しました。' };
    }
}

function updateCoordinateRating({ coordId, rating }) {
  try {
    _findRowByIdAndSetColumn(coordLogSheet, coordId, '評価', rating, 'コーディネートログ');
    return { status: 'success', message: '評価を更新しました。' };
  } catch (e) {
    console.error(`updateCoordinateRating Error: ${e.stack}`);
    return { status: 'error', message: '評価の更新に失敗しました。' };
  }
}

function logCoordinateWear(itemIds) {
  try {
    const timestamp = new Date();
    itemIds.forEach(itemId => {
      const lastRow = wearLogSheet.getLastRow();
      wearLogSheet.appendRow(['', itemId, timestamp]);
      wearLogSheet.getRange(lastRow + 1, 1).setFormula(`=MAX(A$1:A${lastRow}) + 1`);
    });
    _invalidateCache('着用ログ');
    return { status: 'success', message: `${itemIds.length}点の着用を記録しました！` };
  } catch (e) {
    console.error(`logCoordinateWear Error: ${e.stack}`);
    return { status: 'error', message: '着用記録に失敗しました。' };
  }
}

function deleteWearLog(wearLogId) {
    try {
        const range = wearLogSheet.getRange("A:A").createTextFinder(String(wearLogId)).findNext();
        if (!range) throw new Error('指定されたIDの着用記録が見つかりません。');
        wearLogSheet.deleteRow(range.getRow());
        _invalidateCache('着用ログ');
        return { status: 'success', message: '着用記録を削除しました。' };
    } catch (e) {
        console.error(`deleteWearLog Error: ${e.stack}`);
        return { status: 'error', message: '着用記録の削除に失敗しました。' };
    }
}

//----------------------------------------------------------------
// ヘルパー関数
//----------------------------------------------------------------
function masterIdToName(id, sheet) {
  if (!id) return '';
  const data = _getAllSheetValues(sheet);
  if (data.length < 2) return '';
  const match = data.slice(1).find(row => row[0] == id);
  return match ? match[1] : '';
}

function _calculateStats(items) {
  return {
      totalItems: items.length,
      totalCost: items.reduce((sum, item) => sum + (parseFloat(String(item['価格']).replace(/[^0-9.-]+/g, '')) || 0), 0)
  };
}

function _calculateChartData(items) {
  const categoryData = {}, colorData = {}, purchaseData = {}, brandData = {};
  items.forEach(item => {
    const price = parseFloat(String(item['価格']).replace(/[^0-9.-]+/g, '')) || 0;
    categoryData[item['種類'] || '未分類'] = (categoryData[item['種類'] || '未分類'] || 0) + 1;
    colorData[item['色'] || '未分類'] = (colorData[item['色'] || '未分類'] || 0) + 1;
    if (item['購入年'] && item['購入年'] > 1900) purchaseData[item['購入年']] = (purchaseData[item['購入年']] || 0) + price;
    const brand = item['ブランド'] || '不明';
    if (!brandData[brand]) brandData[brand] = { count: 0, amount: 0 };
    brandData[brand].count++;
    brandData[brand].amount += price;
  });
  return { categoryData, colorData, purchaseData, brandData };
}

function _getWearRank(itemsById) {
  const wearLogData = _getAllSheetValues(wearLogSheet);
  if (wearLogData.length < 2) return [];
  const wearCount = wearLogData.slice(1).reduce((acc, row) => {
    const itemId = row[1];
    if (itemId) acc[itemId] = (acc[itemId] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(wearCount)
    .sort(([, countA], [, countB]) => countB - countA).slice(0, 10)
    .map(([itemId, count]) => ({ item: itemsById[itemId], count })).filter(e => e.item);
}

function _getCoordinates(itemsById) {
  const coordLogData = _getAllSheetValues(coordLogSheet);
  if (coordLogData.length < 2) return [];
  return coordLogData.slice(1).map(row => {
      const itemIds = String(row[1]).split(',');
      return {
        id: row[0], itemIds, rating: row[2] || 0,
        items: itemIds.map(id => itemsById[id.trim()]).filter(Boolean),
        reason: row[4] || ''
      };
  });
}

function _getWearDataForItem(itemId) {
    const wearLogValues = _getAllSheetValues(wearLogSheet);
    if (wearLogValues.length < 2) return { total: 0, byYear: {}, history: [] };
    
    const history = [];
    const byYear = {};
    wearLogValues.slice(1).forEach(row => {
        if (row[1] == itemId) {
            const wearDate = new Date(row[2]);
            history.push(wearDate);
            const year = wearDate.getFullYear();
            byYear[year] = (byYear[year] || 0) + 1;
        }
    });
    
    history.sort((a, b) => b - a); // Newest first
    return {
        total: history.length,
        byYear: byYear,
        history: history.slice(0, 10) // Return last 10
    };
}

function _prepareAiContext() {
  const allItems = getItems();
  const itemsById = allItems.reduce((map, item) => (map[item.ID] = item, map), {});
  const favoriteCoords = _getCoordinates(itemsById).filter(c => c.rating >= 4).slice(-10)
    .map(c => c.items.map(i => i['名前']).join(' と '));
  return {
    allItems, itemsById,
    favoriteCoordsPrompt: favoriteCoords.length > 0 ? '# 私のお気に入りコーデ\n' + favoriteCoords.map(c => `- ${c}`).join('\n') + '\n' : '',
    wardrobeForPrompt: allItems.map(item => `ID: ${item.ID}, Name: ${item['名前']}, Category: ${item['種類']}, Color: ${item['色']}, Season: ${item['着用シーズン'] || '未設定'}, Formality: ${item['フォーマル度'] || '未設定'}`).join('\n')
  };
}
