/**
 * @fileoverview Digital Closet アプリケーションのサーバーサイドロジック。
 * データ連携、ビジネスロジック、Gemini APIとの通信を管理します。
 * 全体的にパフォーマンスと堅牢性を向上させるリファクタリングを実施。
 */

//----------------------------------------------------------------
// グローバル定数・初期設定
//----------------------------------------------------------------
const ss = SpreadsheetApp.getActiveSpreadsheet();
const dbSheet = ss.getSheetByName('データベース');
const categoryMasterSheet = ss.getSheetByName('種類番号');
const colorMasterSheet = ss.getSheetByName('色番号');
const wearLogSheet = ss.getSheetByName('着用ログ');
const coordLogSheet = ss.getSheetByName('コーディネートログ');

const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const FOLDER_ID = SCRIPT_PROPERTIES.getProperty('DRIVE_FOLDER_ID');
const GEMINI_API_KEY = SCRIPT_PROPERTIES.getProperty('GEMINI_API_KEY');

/**
 * 起動時に設定値の存在を確認します。
 * @throws {Error} 必須のスクリプトプロパティが設定されていない場合にエラーをスローします。
 */
function checkConfiguration() {
  if (!FOLDER_ID) throw new Error('スクリプトプロパティ「DRIVE_FOLDER_ID」が設定されていません。');
  if (!GEMINI_API_KEY) throw new Error('スクリプトプロパティ「GEMINI_API_KEY」が設定されていません。');
}

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
// データ取得 (Read) - パフォーマンス向上のため初期データは一括取得
//----------------------------------------------------------------
/**
 * アプリ初期化時に必要なすべてのデータを一括で取得します。
 * @returns {object} アプリケーションの初期状態に必要なデータ。
 */
function getInitialData() {
  try {
    const allItems = _getAllItemsFromSheet();
    return {
      items: allItems.filter(item => !item['廃棄年']),
      disposedItems: allItems.filter(item => item['廃棄年']),
      masterData: getOptions()
    };
  } catch (e) {
    console.error('getInitialData Error: ' + e.stack);
    return { error: '初期データの取得に失敗しました: ' + e.message };
  }
}

function getOptions() {
  const getMasterData = (sheet) => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues()
      .map(row => ({ id: row[0], name: row[1], code: row[2] || null }))
      .filter(item => item.id && item.name);
  };
  return {
    categories: getMasterData(categoryMasterSheet),
    colors: getMasterData(colorMasterSheet)
  };
}

// 他の単独データ取得関数は、必要に応じて残すか、getInitialDataに統合します。
// 今回はダッシュボードなどで再利用するため残します。
function getItems() {
  try {
    return _getAllItemsFromSheet().filter(item => !item['廃棄年']);
  } catch (e) {
    console.error('getItems Error: ' + e.stack);
    return { error: 'アイテムデータの取得中にエラーが発生しました。' };
  }
}

function getDashboardData() {
  try {
    const items = getItems();
    if (items.error) throw new Error(items.error);
    const itemsById = items.reduce((map, item) => { map[item.ID] = item; return map; }, {});
    const { totalCost, categoryData, colorData, purchaseData, brandData } = _calculateStats(items);
    const wearRank = _getWearRank(itemsById);
    const coordinates = _getCoordinates(itemsById);
    const colorMaster = getOptions().colors;

    return {
      stats: { totalItems: items.length, totalCost: totalCost },
      categoryData, colorData, purchaseData, brandData, wearRank,
      coordinates: coordinates.reverse(),
      colorMaster: colorMaster
    };
  } catch (e) {
    console.error('getDashboardData Error: ' + e.stack);
    return { error: 'ダッシュボードデータの生成中にエラーが発生しました。' };
  }
}


function getItemDetails(itemId) {
  try {
    if (!itemId) throw new Error('アイテムIDが指定されていません。');
    const allItems = getItems();
    if (allItems.error) throw new Error(allItems.error);
    const itemsById = allItems.reduce((map, item) => { map[item.ID] = item; return map; }, {});
    const targetItem = itemsById[itemId];
    if (!targetItem) throw new Error('アイテムが見つかりません。');
    const allCoordinates = _getCoordinates(itemsById);
    const relatedCoordinates = allCoordinates
      .filter(coord => coord.itemIds.includes(String(itemId)))
      .sort((a, b) => b.rating - a.rating);
    return { item: targetItem, coordinates: relatedCoordinates };
  } catch (e) {
    console.error('getItemDetails Error: ' + e.stack);
    return { error: 'アイテム詳細の取得中にエラーが発生しました: ' + e.message };
  }
}


//----------------------------------------------------------------
// データ更新 (Create/Update/Delete) - パフォーマンスと保守性を改善
//----------------------------------------------------------------

function saveItem(itemData) {
  try {
    const headers = _getHeaders(dbSheet);
    const formulaColumns = ['ID', '種類番号', '色番号', '着用年数'];
    let targetRow;
    let message;

    if (itemData.id) {
      targetRow = _findRowById(dbSheet, itemData.id);
      if (!targetRow) throw new Error('指定されたIDのアイテムが見つかりません。');
      message = 'アイテムを更新しました。';
    } else {
      // 画像なしで新規登録する場合のフォールバック
      const tempResult = _prepareNewItemRow();
      targetRow = tempResult.rowIndex;
      itemData.id = tempResult.newItemId;
      message = '新しいアイテムを登録しました。';
    }

    const targetRange = dbSheet.getRange(targetRow, 1, 1, headers.length);
    const currentValues = targetRange.getValues()[0];

    const newValues = headers.map((header, i) => {
      if (formulaColumns.includes(header)) return currentValues[i];
      if (header === '種類') return masterIdToName(itemData['種類番号'], categoryMasterSheet);
      if (header === '色') return masterIdToName(itemData['色番号'], colorMasterSheet);
      return (header in itemData) ? itemData[header] : currentValues[i];
    });

    targetRange.setValues([newValues]);
    SpreadsheetApp.flush();

    const updatedItem = _convertRowToObject(dbSheet.getRange(targetRow, 1, 1, headers.length).getDisplayValues()[0], headers);
    return { status: 'success', message, item: updatedItem };

  } catch (e) {
    console.error('saveItem Error: ' + e.stack);
    return { status: 'error', message: '保存に失敗しました: ' + e.message };
  }
}

function uploadImage(payload) {
  const { fileData, fileName, itemId } = payload;
  try {
    checkConfiguration();
    let targetItemId = itemId;
    let isNewItem = false;

    if (!targetItemId) {
      isNewItem = true;
      const newRowData = _prepareNewItemRow();
      targetItemId = newRowData.newItemId;
    }

    if (fileData) {
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
    console.error('uploadImage Error: ' + e.stack);
    return { error: '画像処理中にエラーが発生しました: ' + e.message };
  }
}

function deleteItem(id) {
  try {
    if (!id) throw new Error('IDが指定されていません。');
    const targetRow = _findRowById(dbSheet, id);
    if (!targetRow) throw new Error('指定されたIDのアイテムが見つかりません。');

    const headers = _getHeaders(dbSheet);
    const disposeColIndex = headers.indexOf('廃棄年');
    if (disposeColIndex === -1) throw new Error('廃棄年列が見つかりません。');
    
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd');
    dbSheet.getRange(targetRow, disposeColIndex + 1).setValue(today);

    return { status: 'success', message: 'アイテムを廃棄済みにしました。', itemId: id };
  } catch (e) {
    console.error('deleteItem Error: ' + e.stack);
    return { status: 'error', message: e.message };
  }
}

function restoreItem(id) {
  try {
    if (!id) throw new Error('IDが指定されていません。');
    const targetRow = _findRowById(dbSheet, id);
    if (!targetRow) throw new Error('指定されたIDのアイテムが見つかりません。');
    
    const headers = _getHeaders(dbSheet);
    const disposeColIndex = headers.indexOf('廃棄年');
    if (disposeColIndex === -1) throw new Error('廃棄年列が見つかりません。');

    dbSheet.getRange(targetRow, disposeColIndex + 1).clearContent();
    SpreadsheetApp.flush();

    const restoredItem = _convertRowToObject(dbSheet.getRange(targetRow, 1, 1, headers.length).getDisplayValues()[0], headers);
    return { status: 'success', message: 'アイテムを元に戻しました。', item: restoredItem };
  } catch (e) {
    console.error('restoreItem Error: ' + e.stack);
    return { status: 'error', message: e.message };
  }
}

function logWear(itemId) {
  try {
    if (!itemId) throw new Error('アイテムIDが指定されていません。');
    const newRowIndex = wearLogSheet.getLastRow() + 1;
    wearLogSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
    wearLogSheet.getRange(newRowIndex, 2, 1, 2).setValues([[itemId, new Date()]]);
    return { status: 'success', message: '着用を記録しました！' };
  } catch (e) {
    console.error('logWear Error: ' + e.stack);
    return { status: 'error', message: '着用記録に失敗しました。' };
  }
}


function saveCoordinate(payload) {
  const { itemIds, rating, reason, coordId } = payload;
  try {
    if (!itemIds || itemIds.length === 0) throw new Error('アイテムが選択されていません。');
    const sortedIds = [...itemIds].sort((a, b) => a - b).join(',');

    if (coordId) {
      const targetRow = _findRowById(coordLogSheet, coordId);
      if (!targetRow) throw new Error('指定されたIDのコーデが見つかりません。');
      coordLogSheet.getRange(targetRow, 2).setValue(sortedIds);
      if (rating !== undefined) coordLogSheet.getRange(targetRow, 3).setValue(rating);
      if (reason !== undefined) coordLogSheet.getRange(targetRow, 5).setValue(reason);
      return { status: 'success', message: 'コーディネートを更新しました！' };
    }
    
    const lastRow = coordLogSheet.getLastRow();
    if (lastRow > 1) {
      const existingCoords = coordLogSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
      if (existingCoords.some(c => String(c).split(',').sort().join(',') === sortedIds)) {
        return { status: 'error', message: '同じ組み合わせのコーデが既に保存されています。' };
      }
    }
    
    const newRowIndex = lastRow + 1;
    coordLogSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
    const newRowData = [sortedIds, (rating || ''), new Date(), reason || ''];
    coordLogSheet.getRange(newRowIndex, 2, 1, newRowData.length).setValues([newRowData]);
    return { status: 'success', message: 'コーディネートを保存しました！' };
  } catch (e) {
    console.error('saveCoordinate Error: ' + e.stack);
    return { status: 'error', message: 'コーディネートの保存に失敗しました。' };
  }
}

function deleteCoordinate(coordId) {
  try {
    if (!coordId) throw new Error('コーデIDが指定されていません。');
    const targetRow = _findRowById(coordLogSheet, coordId);
    if (!targetRow) throw new Error('指定されたIDのコーデが見つかりません。');
    coordLogSheet.deleteRow(targetRow);
    return { status: 'success', message: 'コーデを削除しました。' };
  } catch (e) {
    console.error('deleteCoordinate Error: ' + e.stack);
    return { status: 'error', message: 'コーデの削除に失敗しました。' };
  }
}

function updateCoordinateRating(payload) {
  const { coordId, rating } = payload;
  try {
    if (!coordId || !rating) throw new Error('IDまたは評価が指定されていません。');
    const targetRow = _findRowById(coordLogSheet, coordId);
    if (!targetRow) throw new Error('指定されたIDのコーデが見つかりません。');
    coordLogSheet.getRange(targetRow, 3).setValue(rating);
    return { status: 'success', message: '評価を更新しました。' };
  } catch (e) {
    console.error('updateCoordinateRating Error: ' + e.stack);
    return { status: 'error', message: '評価の更新に失敗しました。' };
  }
}

function logCoordinateWear(itemIds) {
  try {
    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      throw new Error('アイテムIDが指定されていません。');
    }
    const timestamp = new Date();
    const rowsToAdd = itemIds.map(id => ['', id, timestamp]);
    wearLogSheet.getRange(wearLogSheet.getLastRow() + 1, 1, rowsToAdd.length, 3).setValues(rowsToAdd);
    
    // ID列の数式を一括で設定
    const lastRow = wearLogSheet.getLastRow();
    const startRow = lastRow - itemIds.length + 1;
    const idFormulas = Array.from({ length: itemIds.length }, (_, i) => [`=MAX(A$1:A${startRow + i - 1}) + 1`]);
    wearLogSheet.getRange(startRow, 1, itemIds.length, 1).setFormulas(idFormulas);
    
    return { status: 'success', message: `${itemIds.length}点の着用を記録しました！` };
  } catch (e) {
    console.error('logCoordinateWear Error: ' + e.stack);
    return { status: 'error', message: '着用記録に失敗しました。' };
  }
}

//----------------------------------------------------------------
// AI 関連関数 - 堅牢性を向上
//----------------------------------------------------------------
function getStyleSuggestion(payload) {
  try {
    checkConfiguration();
    const { baseItemId, customRequest } = payload;
    const { allItems, itemsById, favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const baseItem = itemsById[baseItemId];
    if (!baseItem) throw new Error('基準となるアイテムが見つかりません。');

    const prompt = `あなたは私の好みを深く理解した、プロのファッションスタイリストです。
以下の情報を総合的に判断し、「基準アイテム」に合うコーディネートを最大3つ提案してください。
特に、以下の「今回の要望」を最優先で考慮してください。
次に、「私のお気に入りコーデ」を私の好みの参考としてください。
その上で、各アイテムの「Season」や「Formality」を参考にし、TPOに合った組み合わせを提案してください。
提案は必ず「手持ちの服リスト」内のアイテムから選びます。結果は、前後に他のテキストを一切含まず、有効なJSON形式の配列としてのみ出力してください。
各コーディネートはオブジェクトとし、以下のキーを含めてください:
1. "item_ids": 基準アイテムと提案アイテムのIDを含む配列 (例: ["${baseItem.ID}", "102"])
2. "reason": そのコーディネートの提案理由を、TPOや私の好みを考慮した上で一行で記述した文字列
${customRequest ? `# 今回の要望（最優先事項）\n- ${customRequest.trim()}\n\n` : ''}${favoriteCoordsPrompt}# 手持ちの服リスト
${wardrobeForPrompt}
# 基準アイテム
ID: ${baseItem.ID}, Name: ${baseItem['名前']}, Category: ${baseItem['種類']}, Color: ${baseItem['色']}, Season: ${baseItem['着用シーズン'] || '未設定'}, Formality: ${baseItem['フォーマル度'] || '未設定'}`;

    const result = _getAiResponse(prompt, false);
    const suggestions = JSON.parse(result);
    const detailedSuggestions = suggestions.map(coord => ({
      items: coord.item_ids.map(id => allItems.find(item => item.ID == id)).filter(Boolean),
      reason: coord.reason
    }));
    return { suggestions: detailedSuggestions };

  } catch (e) {
    console.error('getStyleSuggestion Error: ' + e.stack);
    return { error: '提案の生成中にエラーが発生しました: ' + e.message };
  }
}

function analyzeImagesWithAI(images) {
  try {
    checkConfiguration();
    const optionsData = getOptions();
    if (optionsData.error) throw new Error(optionsData.error);
    const prompt = `あなたはプロのファッションアイテムアナリストです。
提供された複数の画像を総合的に分析し、一つの衣類アイテムに関する情報を抽出してください。
以下のルールに従って、指定されたJSONスキーマの形式で回答してください。
- 「種類」と「色」は、必ず指定された選択肢リストの中から最も近いものを一つだけ選んでください。
- 「着用シーズン」は、「春」「夏」「秋」「冬」の中から当てはまるものを全て含んだ配列で回答してください。
- 「フォーマル度」は、1（カジュアル）から5（フォーマル）の5段階で評価してください。
- 「メモ」には、アイテムの特筆すべきデザイン、素材感、コーディネートのヒントなどを簡潔に記述してください。
- 不明な項目は空文字 "" または空の配列 [] としてください。
# 種類選択肢リスト
${optionsData.categories.map(c => c.name).join(', ')}
# 色選択肢リスト
${optionsData.colors.map(c => c.name).join(', ')}`;
    
    const requestBody = {
      "contents": [{"parts": [{ "text": prompt }, ...images.map(image => ({"inline_data": {"mime_type": image.mimeType, "data": image.base64}}))] }],
      "generation_config": {
        "response_mime_type": "application/json",
        "response_schema": { /* ... スキーマ定義 ... */ }
      }
    };
    // スキーマ定義は長いため省略
    requestBody.generation_config.response_schema = { "type": "OBJECT", "properties": { "名前": { "type": "STRING" }, "種類": { "type": "STRING" }, "色": { "type": "STRING" }, "素材": { "type": "STRING" }, "柄": { "type": "STRING" }, "着用シーズン": { "type": "ARRAY", "items": { "type": "STRING" } }, "フォーマル度": { "type": "NUMBER" }, "メモ": { "type": "STRING" }}};

    const result = _getAiResponse(requestBody, true, "gemini-2.5-flash");
    return { data: JSON.parse(result) };

  } catch (e) {
    console.error('analyzeImagesWithAI Error: ' + e.stack);
    return { error: '画像解析中にエラーが発生しました: ' + e.message };
  }
}

function getAiConsultation(userQuestion) {
  try {
    checkConfiguration();
    const prompt = _buildConsultationPrompt(userQuestion);
    return { answer: _getAiResponse(prompt, false) };
  } catch (e) {
    console.error('getAiConsultation Error: ' + e.stack);
    return { error: 'AIへの相談中にエラーが発生しました: ' + e.message };
  }
}

function getAiConsultationWithImages(payload) {
  try {
    checkConfiguration();
    const { userQuestion, images } = payload;
    const prompt = _buildConsultationPrompt(userQuestion);
    const requestBody = { "contents": [{"parts": [{ "text": prompt }, ...images.map(image => ({"inline_data": {"mime_type": image.mimeType, "data": image.base64}}))] }] };
    return { answer: _getAiResponse(requestBody, true) };
  } catch (e) {
    console.error('getAiConsultationWithImages Error: ' + e.stack);
    return { error: 'AIへの相談中にエラーが発生しました: ' + e.message };
  }
}


//----------------------------------------------------------------
// 内部ヘルパー関数
//----------------------------------------------------------------

let memoizedHeaders = {};
function _getHeaders(sheet) {
  const sheetName = sheet.getName();
  if (!memoizedHeaders[sheetName]) {
    memoizedHeaders[sheetName] = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  }
  return memoizedHeaders[sheetName];
}

function _convertRowToObject(row, headers) {
  const obj = {};
  headers.forEach((header, i) => { obj[header] = row[i]; });
  return obj;
}

function _getAllItemsFromSheet() {
  const lastRow = dbSheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = _getHeaders(dbSheet);
  const values = dbSheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues();
  return values.map(row => _convertRowToObject(row, headers)).filter(item => item['ID']);
}

function masterIdToName(id, sheet) {
  if (!id) return '';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues();
  const match = data.find(row => row[0] == id);
  return match ? match[1] : '';
}

function _findRowById(sheet, id) {
  const range = sheet.getRange("A:A").createTextFinder(String(id)).findNext();
  return range ? range.getRow() : null;
}

function _prepareNewItemRow() {
  const newRowIndex = dbSheet.getLastRow() + 1;
  dbSheet.insertRowAfter(newRowIndex - 1);
  dbSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
  dbSheet.getRange(newRowIndex, 2).setFormula(`=IFERROR(XLOOKUP(D${newRowIndex},'種類番号'!B:B,'種類番号'!A:A,""), "")`);
  dbSheet.getRange(newRowIndex, 3).setFormula(`=IFERROR(XLOOKUP(E${newRowIndex},'色番号'!B:B,'色番号'!A:A,""), "")`);
  dbSheet.getRange(newRowIndex, 12).setFormula(`=IF(ISBLANK(J${newRowIndex}), IF(ISBLANK(I${newRowIndex}), "", YEAR(TODAY())-I${newRowIndex}), J${newRowIndex}-I${newRowIndex})`);
  SpreadsheetApp.flush();
  const newItemId = dbSheet.getRange(newRowIndex, 1).getDisplayValue();
  if (!newItemId) {
    dbSheet.deleteRow(newRowIndex);
    throw new Error('新しいアイテムIDの採番に失敗しました。');
  }
  return { rowIndex: newRowIndex, newItemId: newItemId };
}


function _calculateStats(items) { /* ... 変更なし ... */ return { totalCost:0, categoryData:{}, colorData:{}, purchaseData:{}, brandData:{} }; }
function _getWearRank(itemsById) { /* ... 変更なし ... */ return []; }
function _getCoordinates(itemsById) { /* ... 変更なし ... */ return []; }
// For brevity, the content of these helper functions remains the same as your original code.
// They are correct and don't need refactoring.
function _calculateStats(items) {
  let totalCost = 0;
  const categoryData = {}, colorData = {}, purchaseData = {}, brandData = {};
  
  items.forEach(item => {
    const price = parseFloat(String(item['価格']).replace(/[^0-9.-]+/g, '')) || 0;
    totalCost += price;
    categoryData[item['種類'] || '未分類'] = (categoryData[item['種類'] || '未分類'] || 0) + 1;
    colorData[item['色'] || '未分類'] = (colorData[item['色'] || '未分類'] || 0) + 1;
    if (item['購入年'] && item['購入年'] > 1900) { purchaseData[item['購入年']] = (purchaseData[item['購入年']] || 0) + price; }
    const brand = item['ブランド'] || '不明';
    if (!brandData[brand]) { brandData[brand] = { count: 0, amount: 0 }; }
    brandData[brand].count++;
    brandData[brand].amount += price;
  });
  return { totalCost, categoryData, colorData, purchaseData, brandData };
}

function _getWearRank(itemsById) {
  const wearCount = {};
  const wearLogLastRow = wearLogSheet.getLastRow();
  if (wearLogLastRow < 2) return [];
  const wearLogData = wearLogSheet.getRange(2, 2, wearLogLastRow - 1, 1).getDisplayValues().flat();
  wearLogData.forEach(itemId => { if (itemId) { wearCount[itemId] = (wearCount[itemId] || 0) + 1; } });
  return Object.entries(wearCount)
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, 10)
    .map(([itemId, count]) => ({ item: itemsById[itemId], count: count }))
    .filter(entry => entry.item);
}

function _getCoordinates(itemsById) {
    const coordLogLastRow = coordLogSheet.getLastRow();
    if (coordLogLastRow < 2) return [];
    const coordLogData = coordLogSheet.getRange(2, 1, coordLogLastRow - 1, 5).getDisplayValues();
    return coordLogData.map(row => {
        const itemIds = String(row[1]).split(',');
        return {
          id: row[0],
          itemIds: itemIds,
          rating: row[2] || 0,
          items: itemIds.map(id => itemsById[id.trim()]).filter(Boolean),
          reason: row[4] || ''
        };
    });
}

function _prepareAiContext() {
  const allItems = getItems();
  if (allItems.error) throw new Error(allItems.error);
  const itemsById = allItems.reduce((map, item) => { map[item.ID] = item; return map; }, {});

  let favoriteCoordsPrompt = '';
  const coordLogLastRow = coordLogSheet.getLastRow();
  if (coordLogLastRow >= 2) {
    const favoriteCoords = coordLogSheet.getRange(2, 1, coordLogLastRow - 1, 3).getValues()
      .filter(row => row[2] && Number(row[2]) >= 4)
      .map(row => String(row[1]).split(',').map(id => itemsById[id.trim()] ? itemsById[id.trim()]['名前'] : null).filter(Boolean).join(' と '))
      .slice(-10);
    if (favoriteCoords.length > 0) {
      favoriteCoordsPrompt = '# 私のお気に入りコーデ（高評価の組み合わせ参考例）\n' + favoriteCoords.map(c => `- ${c}`).join('\n') + '\n\n';
    }
  }
  const wardrobeForPrompt = allItems.map(item => `ID: ${item.ID}, Name: ${item['名前']}, Category: ${item['種類']}, Color: ${item['色']}, Season: ${item['着用シーズン'] || '未設定'}, Formality: ${item['フォーマル度'] || '未設定'}`).join('\n');
  return { allItems, itemsById, favoriteCoordsPrompt, wardrobeForPrompt };
}

function _buildConsultationPrompt(userQuestion) {
  const { favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
  const simpleWardrobe = wardrobeForPrompt.split('\n').map(line => {
    const match = line.match(/ID: (\d+), Name: (.*?), Category: (.*?), Color: (.*?), Season: (.*?), Formality: (.*)/);
    return match ? `- ID:${match[1]}, ${match[2]} (${match[3]}, ${match[4]}, ${match[5]})` : null;
  }).filter(Boolean).join('\n');
  const simpleFavs = favoriteCoordsPrompt.replace('# 私のお気に入りコーデ（高評価の組み合わせ参考例）', '## 私の好きなコーデの傾向').replace(/\n\n$/, '');

  return `あなたは私の専属ファッションスタイリストです。以下の情報を参考に、私の質問に回答してください。
# 指示
- 質問に対して、具体的かつ簡潔に回答してください。
- 挨拶や前置き、結びの言葉は一切不要です。
- 回答には、マークダウンを使用しないでください。
- 私のワードローブにあるアイテムを提案する場合は、必ず「ID:〇〇」の形式でアイテムIDを明記してください。
- 添付画像がある場合、それも考慮して回答してください。
# 私のワードローブ
${simpleWardrobe}
${simpleFavs}
---
# 私からの質問
${userQuestion}`;
}


function _getAiResponse(payload, isComplexPayload = false, model = 'gemini-2.5-pro') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const requestBody = isComplexPayload ? payload : { "contents": [{ "parts": [{ "text": payload }] }] };
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(requestBody), 'muteHttpExceptions': true };
  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const resultText = response.getContentText();

  if (responseCode !== 200) {
    console.error(`Gemini API Error (Code: ${responseCode}): ${resultText}`);
    throw new Error(`AIとの通信に失敗しました。`);
  }
  try {
    const result = JSON.parse(resultText);
    if (result.candidates && result.candidates[0].content) {
      let text = result.candidates[0].content.parts[0].text;
      return text.replace(/```json/g, '').replace(/```/g, '').trim();
    }
    throw new Error('AIからの応答が予期せぬ形式でした。');
  } catch (e) {
    console.error('AI Response Parse Error: ' + e.message);
    console.error('Original AI Response: ' + resultText);
    throw new Error('AIからの応答解析に失敗しました。');
  }
}
