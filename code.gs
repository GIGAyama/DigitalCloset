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

//----------------------------------------------------------------
// Webアプリケーションのエントリーポイント
//----------------------------------------------------------------

function doGet() {
  return HtmlService.createTemplateFromFile('index').evaluate()
   .setTitle('Digital Closet');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

//----------------------------------------------------------------
// 画像アップロード & 新規行準備
//----------------------------------------------------------------

function uploadImage(payload) {
  const { fileData, fileName, itemId } = payload;
  try {
    const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
    
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

      if (!targetItemId) {
        dbSheet.deleteRow(newRowIndex);
        throw new Error('新しいアイテムIDの採番に失敗しました。');
      }
    }
    
    if (fileData && FOLDER_ID) {
      const folder = DriveApp.getFolderById(FOLDER_ID);
      const contentType = fileData.substring(5, fileData.indexOf(';'));
      const bytes = Utilities.base64Decode(fileData.substring(fileData.indexOf('base64,') + 7));
      const blob = Utilities.newBlob(bytes, contentType, fileName);
      const extension = fileName.includes('.') ? fileName.split('.').pop() : 'jpg';
      const newFileName = `${targetItemId}.${extension}`;

      let file;
      const existingFiles = folder.getFilesByName(newFileName);
      if (existingFiles.hasNext()) {
        file = existingFiles.next();
        file.setContent(blob.getBytes());
      } else {
        file = folder.createFile(blob).setName(newFileName);
      }
      
      const result = { fileId: file.getId() };
      if (isNewItem) {
        result.newItemId = targetItemId;
      }
      return result;
    } else if (isNewItem) {
      return { newItemId: targetItemId, fileId: '' };
    } else {
      return { fileId: '' };
    }

  } catch (e) {
    console.error('uploadImage Error: ' + e.stack);
    return { error: '処理中にエラーが発生しました: ' + e.message };
  }
}

//----------------------------------------------------------------
// データ取得 (Read)
//----------------------------------------------------------------

function _getAllItemsFromSheet() {
  const lastRow = dbSheet.getLastRow();
  if (lastRow < 2) return [];
  const values = dbSheet.getRange(1, 1, lastRow, dbSheet.getLastColumn()).getDisplayValues();
  const headers = values.shift();
  return values.map(row => {
    const item = {};
    headers.forEach((header, i) => { item[header] = row[i]; });
    return item;
  }).filter(item => item['ID']);
}

function getItems() {
  try {
    return _getAllItemsFromSheet().filter(item => !item['廃棄年']);
  } catch (e) {
    console.error('getItems Error: ' + e.stack);
    return { error: 'アイテムデータの取得中にエラーが発生しました。' };
  }
}

function getDisposedItems() {
  try {
    return _getAllItemsFromSheet().filter(item => item['廃棄年']);
  } catch (e) {
    console.error('getDisposedItems Error: ' + e.stack);
    return { error: '廃棄済みアイテムデータの取得中にエラーが発生しました。' };
  }
}

function getOptions() {
  try {
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
  } catch (e) {
    console.error('getOptions Error: ' + e.stack);
    return { error: '選択肢データの取得中にエラーが発生しました。' };
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

/**
 * ★新機能：ご無沙汰アイテムを取得
 * @param {string} type 'last_worn' (最後に着てから最も日数が経っている順) または 'wear_count' (着用回数が少ない順)
 * @returns {Array} ご無沙汰アイテムのトップ5
 */
function getNeglectedItems(type) {
  try {
    const items = getItems();
    if (items.error) throw new Error(items.error);
    
    const wearLogLastRow = wearLogSheet.getLastRow();
    if (wearLogLastRow < 2) return [];

    const wearLog = wearLogSheet.getRange(2, 2, wearLogLastRow - 1, 2).getValues();
    
    const wearStats = {};
    items.forEach(item => {
      wearStats[item.ID] = {
        item: item,
        wearCount: 0,
        lastWorn: new Date(0) // 1970-01-01
      };
    });

    wearLog.forEach(([itemId, date]) => {
      if (wearStats[itemId]) {
        wearStats[itemId].wearCount++;
        const wearDate = new Date(date);
        if (wearDate > wearStats[itemId].lastWorn) {
          wearStats[itemId].lastWorn = wearDate;
        }
      }
    });

    let sortedItems = Object.values(wearStats);

    if (type === 'last_worn') {
      sortedItems.sort((a, b) => a.lastWorn - b.lastWorn);
    } else { // 'wear_count'
      sortedItems.sort((a, b) => {
        if (a.wearCount !== b.wearCount) {
          return a.wearCount - b.wearCount;
        }
        return a.lastWorn - b.lastWorn; // 回数が同じ場合は古い順
      });
    }

    return sortedItems.slice(0, 5).map(stat => ({
      item: stat.item,
      wearCount: stat.wearCount,
      lastWorn: stat.lastWorn > new Date(0) ? Utilities.formatDate(stat.lastWorn, Session.getScriptTimeZone(), 'yyyy/MM/dd') : '着用記録なし'
    }));

  } catch(e) {
    console.error('getNeglectedItems Error: ' + e.stack);
    return { error: 'ご無沙汰アイテムの取得中にエラーが発生しました: ' + e.message };
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
    
    // ★新機能：着用統計とコストパフォーマンスを追加
    const wearStats = _getItemWearStats(itemId);
    const price = parseFloat(String(targetItem['価格']).replace(/[^0-9.-]+/g, '')) || 0;
    let costPerWear = 0;
    if (price > 0 && wearStats.total > 0) {
      costPerWear = Math.round(price / wearStats.total);
    }

    return { 
      item: targetItem, 
      coordinates: relatedCoordinates,
      wearStats: wearStats,
      costPerWear: costPerWear
    };

  } catch (e) {
    console.error('getItemDetails Error: ' + e.stack);
    return { error: 'アイテム詳細の取得中にエラーが発生しました: ' + e.message };
  }
}

// --- AI関連 ---

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


function getStyleSuggestion(payload) {
  const { baseItemId, customRequest } = payload;
  try {
    const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!API_KEY) { return { error: 'Gemini APIキーがスクリプトプロティに設定されていません。' }; }
    
    const { allItems, itemsById, favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const baseItem = itemsById[baseItemId];
    if (!baseItem) throw new Error('基準となるアイテムが見つかりません。');
    
    let customRequestPrompt = '';
    if (customRequest && customRequest.trim() !== '') {
      customRequestPrompt = `# 今回の要望（最優先事項）\n- ${customRequest.trim()}\n\n`;
    }
    
    const baseItemForPrompt = `ID: ${baseItem.ID}, Name: ${baseItem['名前']}, Category: ${baseItem['種類']}, Color: ${baseItem['色']}, Season: ${baseItem['着用シーズン'] || '未設定'}, Formality: ${baseItem['フォーマル度'] || '未設定'}`;
    
    const prompt = `あなたは私の好みを深く理解した、プロのファッションスタイリストです。
以下の情報を総合的に判断し、「基準アイテム」に合うコーディネートを最大3つ提案してください。
特に、以下の「今回の要望」を最優先で考慮してください。
次に、「私のお気に入りコーデ」を私の好みの参考としてください。
その上で、各アイテムの「Season」や「Formality」を参考にし、TPOに合った組み合わせを提案してください。
提案は必ず「手持ちの服リスト」内のアイテムから選びます。結果は、前後に他のテキストを一切含まず、有効なJSON形式の配列としてのみ出力してください。
各コーディネートはオブジェクトとし、以下のキーを含めてください:
1. "item_ids": 基準アイテムと提案アイテムのIDを含む配列 (例: ["${baseItem.ID}", "102"])
2. "reason": そのコーディネートの提案理由を、TPOや私の好みを考慮した上で一行で記述した文字列
${customRequestPrompt}${favoriteCoordsPrompt}# 手持ちの服リスト
${wardrobeForPrompt}
# 基準アイテム
${baseItemForPrompt}`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + API_KEY;
    const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify({ "contents": [{ "parts": [{ "text": prompt }] }] }) };
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (result.candidates && result.candidates[0].content) {
       let suggestionText = result.candidates[0].content.parts[0].text;
       suggestionText = suggestionText.replace(/```json/g, '').replace(/```/g, '').trim();
       const suggestions = JSON.parse(suggestionText);
       const detailedSuggestions = suggestions.map(coord => ({
          items: coord.item_ids.map(id => allItems.find(item => item.ID == id)).filter(Boolean),
          reason: coord.reason
       }));
       return { suggestions: detailedSuggestions };
    } else {
       console.error("Gemini API response format error: ", JSON.stringify(result));
       throw new Error('AIからの応答を解析できませんでした。');
    }
  } catch (e) {
    console.error('getStyleSuggestion Error: ' + e.stack);
    return { error: '提案の生成中にエラーが発生しました: ' + e.message };
  }
}

function analyzeImagesWithAI(images) {
  try {
    const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!API_KEY) { return { error: 'Gemini APIキーが設定されていません。' }; }
    const optionsData = getOptions();
    if (optionsData.error) throw new Error(optionsData.error);
    const categoryList = optionsData.categories.map(c => c.name).join(', ');
    const colorList = optionsData.colors.map(c => c.name).join(', ');
    const prompt = `あなたはプロのファッションアイテムアナリストです。
提供された複数の画像を総合的に分析し、一つの衣類アイテムに関する情報を抽出してください。
以下のルールに従って、指定されたJSONスキーマの形式で回答してください。
- 「種類」と「色」は、必ず指定された選択肢リストの中から最も近いものを一つだけ選んでください。
- 「着用シーズン」は、「春」「夏」「秋」「冬」の中から当てはまるものを全て含んだ配列で回答してください。
- 「フォーマル度」は、1（カジュアル）から5（フォーマル）の5段階で評価してください。
- 「メモ」には、アイテムの特筆すべきデザイン、素材感、コーディネートのヒントなどを簡潔に記述してください。
- 不明な項目は空文字 "" または空の配列 [] としてください。
# 種類選択肢リスト
${categoryList}
# 色選択肢リスト
${colorList}
`;
    const requestBody = {
      "contents": [{"parts": [{ "text": prompt }, ...images.map(image => ({"inline_data": {"mime_type": image.mimeType, "data": image.base64}}))] }],
      "generation_config": {
        "response_mime_type": "application/json",
        "response_schema": {
          "type": "OBJECT", "properties": {
            "名前": { "type": "STRING" }, "種類": { "type": "STRING" }, "色": { "type": "STRING" },
            "素材": { "type": "STRING" }, "柄": { "type": "STRING" },
            "着用シーズン": { "type": "ARRAY", "items": { "type": "STRING" } },
            "フォーマル度": { "type": "NUMBER" }, "メモ": { "type": "STRING" }
          }
        }
      }
    };
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + API_KEY;
    const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(requestBody) };
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    if (result.candidates && result.candidates[0].content) {
      const itemData = JSON.parse(result.candidates[0].content.parts[0].text);
      return { data: itemData };
    } else {
      console.error("Gemini API (Vision) response format error: ", JSON.stringify(result));
      return { error: 'AIからの応答を解析できませんでした。' };
    }
  } catch (e) {
    console.error('analyzeImagesWithAI Error: ' + e.stack);
    return { error: '画像解析中にエラーが発生しました: ' + e.message };
  }
}

function getAiConsultation(userQuestion) {
  try {
    const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!API_KEY) { return { error: 'Gemini APIキーが設定されていません。' }; }
    
    const { favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const simpleWardrobe = wardrobeForPrompt.split('\n').map(line => {
        const idMatch = line.match(/ID: (\d+)/);
        const nameMatch = line.match(/Name: (.*?)\,/);
        const categoryMatch = line.match(/Category: (.*?)\,/);
        const colorMatch = line.match(/Color: (.*?)\,/);
        const seasonMatch = line.match(/Season: (.*?)$/);
        if (idMatch && nameMatch && categoryMatch && colorMatch && seasonMatch) {
            return `- ID:${idMatch[1]}, ${nameMatch[1]} (${categoryMatch[1]}, ${colorMatch[1]}, ${seasonMatch[1]})`;
        }
        return null;
    }).filter(Boolean).join('\n');
    
    const simpleFavs = favoriteCoordsPrompt.replace('# 私のお気に入りコーデ（高評価の組み合わせ参考例）', '## 私の好きなコーデの傾向').replace(/\n\n$/, '');

    const prompt = `あなたは私の専属ファッションスタイリストです。以下の情報を参考に、私の質問に回答してください。
# 指示
- 質問に対して、具体的かつ簡潔に回答してください。
- 挨拶や前置き、結びの言葉（「いかがでしたか？」など）は一切不要です。
- 回答には、マークダウン（**太字**や- リストなど）を使用しないでください。
- 私のワードローブにあるアイテムを提案する場合は、必ず「ID:〇〇」の形式でアイテムIDを明記してください。

# 私のワードローブ
${simpleWardrobe}

${simpleFavs}
---
# 私からの質問
${userQuestion}`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + API_KEY;
    const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify({ "contents": [{ "parts": [{ "text": prompt }] }] }) };
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    if (result.candidates && result.candidates[0].content) {
      return { answer: result.candidates[0].content.parts[0].text };
    } else {
      console.error("Gemini API consultation error: ", JSON.stringify(result));
      return { error: 'AIからの応答を取得できませんでした。' };
    }
  } catch (e) {
    console.error('getAiConsultation Error: ' + e.stack);
    return { error: 'AIへの相談中にエラーが発生しました: ' + e.message };
  }
}

function getAiConsultationWithImages(payload) {
  const { userQuestion, images } = payload;
  try {
    const API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!API_KEY) { return { error: 'Gemini APIキーが設定されていません。' }; }
    
    const { favoriteCoordsPrompt, wardrobeForPrompt } = _prepareAiContext();
    const simpleWardrobe = wardrobeForPrompt.split('\n').map(line => {
        const idMatch = line.match(/ID: (\d+)/);
        const nameMatch = line.match(/Name: (.*?)\,/);
        const categoryMatch = line.match(/Category: (.*?)\,/);
        const colorMatch = line.match(/Color: (.*?)\,/);
        const seasonMatch = line.match(/Season: (.*?)$/);
        if (idMatch && nameMatch && categoryMatch && colorMatch && seasonMatch) {
            return `- ID:${idMatch[1]}, ${nameMatch[1]} (${categoryMatch[1]}, ${colorMatch[1]}, ${seasonMatch[1]})`;
        }
        return null;
    }).filter(Boolean).join('\n');
    const simpleFavs = favoriteCoordsPrompt.replace('# 私のお気に入りコーデ（高評価の組み合わせ参考例）', '## 私の好きなコーデの傾向').replace(/\n\n$/, '');

    const prompt = `あなたは私の専属ファッションスタイリストです。以下の情報を総合的に参考にし、私の質問に回答してください。
# 指示
- 添付された画像、私の質問、私のワードローブ、好きなコーデの傾向をすべて考慮してください。
- 質問に対して、具体的かつ簡潔に回答してください。
- 挨拶や前置き、結びの言葉（「いかがでしたか？」など）は一切不要です。
- 回答には、マークダウン（**太字**や- リストなど）を使用しないでください。
- 私のワードローブにあるアイテムを提案する場合は、必ず「ID:〇〇」の形式でアイテムIDを明記してください。
- 添付画像が「購入を検討しているアイテム」である場合、私の手持ちの服（ワードローブ）と合うかどうか、どんなコーデが組めるかを具体的に提案してください。

# 私のワードローブ
${simpleWardrobe}

${simpleFavs}
---
# 私からの質問
${userQuestion}`;
    
    const requestBody = {
      "contents": [{"parts": [{ "text": prompt }, ...images.map(image => ({"inline_data": {"mime_type": image.mimeType, "data": image.base64}}))] }],
    };

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + API_KEY;
    const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(requestBody) };
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (result.candidates && result.candidates[0].content) {
      return { answer: result.candidates[0].content.parts[0].text };
    } else {
      console.error("Gemini API vision consultation error: ", JSON.stringify(result));
      return { error: 'AIからの応答を取得できませんでした。' };
    }
  } catch (e) {
    console.error('getAiConsultationWithImages Error: ' + e.stack);
    return { error: 'AIへの相談中にエラーが発生しました: ' + e.message };
  }
}

//----------------------------------------------------------------
// データ更新 (Create/Update/Delete)
//----------------------------------------------------------------

function saveItem(itemData) {
  try {
    const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
    const formulaColumns = ['ID', '種類番号', '色番号', '着用年数'];
    
    let targetRow;
    let message;

    if (itemData.id) {
      const range = dbSheet.getRange("A:A").createTextFinder(String(itemData.id)).findNext();
      if (!range) { throw new Error('指定されたIDのアイテムが見つかりません。'); }
      targetRow = range.getRow();
      message = 'アイテムを更新しました。';
    } else {
      const tempResult = uploadImage({});
      if (tempResult.error) throw new Error(tempResult.error);
      targetRow = dbSheet.getLastRow();
      itemData.id = tempResult.newItemId;
      message = '新しいアイテムを登録しました。';
    }

    headers.forEach((header, i) => {
      if (formulaColumns.includes(header)) return;
      
      const value = itemData[header];
      // 種類名・色名は itemData から直接渡さず、スプレッドシートの XLOOKUP で導出させる
      const isMasterDataField = header === '種類' || header === '色';
      const valueToSet = isMasterDataField ? itemData[header] : value;
      
      if (valueToSet !== undefined && valueToSet !== null) {
        dbSheet.getRange(targetRow, i + 1).setValue(valueToSet);
      }
    });
    
    return { status: 'success', message: message };
    
  } catch (e) {
    console.error('saveItem Error: ' + e.stack);
    return { status: 'error', message: '保存に失敗しました: ' + e.message };
  }
}

function deleteItem(id) {
    try {
        if (!id) throw new Error('IDが指定されていません。');
        const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
        const disposeColIndex = headers.indexOf('廃棄年');
        if (disposeColIndex === -1) { throw new Error('廃棄年列が見つかりません。'); }
        
        const range = dbSheet.getRange("A:A").createTextFinder(String(id)).findNext();
        if (!range) { throw new Error('指定されたIDのアイテムが見つかりません。'); }

        const today = new Date();
        const formattedDate = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy/MM/dd');
        dbSheet.getRange(range.getRow(), disposeColIndex + 1).setValue(formattedDate);
        
        return { status: 'success', message: 'アイテムを廃棄済みにしました。' };
    } catch (e) {
        console.error('deleteItem Error: ' + e.stack);
        return { status: 'error', message: e.message };
    }
}

function restoreItem(id) {
    try {
        if (!id) throw new Error('IDが指定されていません。');
        const headers = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
        const disposeColIndex = headers.indexOf('廃棄年');
        if (disposeColIndex === -1) { throw new Error('廃棄年列が見つかりません。'); }

        const range = dbSheet.getRange("A:A").createTextFinder(String(id)).findNext();
        if (!range) { throw new Error('指定されたIDのアイテムが見つかりません。'); }

        dbSheet.getRange(range.getRow(), disposeColIndex + 1).clearContent();
        
        return { status: 'success', message: 'アイテムを元に戻しました。' };
    } catch (e) {
        console.error('restoreItem Error: ' + e.stack);
        return { status: 'error', message: e.message };
    }
}

function logWear(itemId) {
  try {
    if (!itemId) { throw new Error('アイテムIDが指定されていません。'); }
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
    if (!itemIds || itemIds.length === 0) { throw new Error('アイテムが選択されていません。'); }
    
    const sortedIds = [...itemIds].sort((a, b) => a - b).join(',');

    if (coordId) {
      const range = coordLogSheet.getRange("A:A").createTextFinder(String(coordId)).findNext();
      if (!range) { throw new Error('指定されたIDのコーデが見つかりません。'); }
      
      coordLogSheet.getRange(range.getRow(), 2).setValue(sortedIds);
      if (rating !== undefined) coordLogSheet.getRange(range.getRow(), 3).setValue(rating);
      if (reason !== undefined) coordLogSheet.getRange(range.getRow(), 5).setValue(reason);
      return { status: 'success', message: 'コーディネートを更新しました！' };
    }

    const lastRow = coordLogSheet.getLastRow();
    if (lastRow > 1) {
        const existingCoords = coordLogSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
        const isDuplicate = existingCoords.some(coord => {
            const existingSorted = String(coord).split(',').sort((a, b) => a - b).join(',');
            return existingSorted === sortedIds;
        });
        if (isDuplicate) {
            return { status: 'error', message: '同じ組み合わせのコーデが既に保存されています。' };
        }
    }
    
    const newRowIndex = lastRow + 1;
    coordLogSheet.getRange(newRowIndex, 1).setFormula(`=MAX(A$1:A${newRowIndex - 1}) + 1`);
    
    const ratingValue = (rating && rating > 0) ? rating : '';
    const newRowData = [sortedIds, ratingValue, new Date(), reason || ''];
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
        const range = coordLogSheet.getRange("A:A").createTextFinder(String(coordId)).findNext();
        if (!range) { throw new Error('指定されたIDのコーデが見つかりません。'); }

        coordLogSheet.deleteRow(range.getRow());
        return { status: 'success', message: 'コーデを削除しました。' };
    } catch (e) {
        console.error('deleteCoordinate Error: ' + e.stack);
        return { status: 'error', message: 'コーデの削除に失敗しました。' };
    }
}

function updateCoordinateRating(payload) {
  const { coordId, rating } = payload;
  try {
    if (!coordId || !rating) { throw new Error('IDまたは評価が指定されていません。'); }
    const range = coordLogSheet.getRange("A:A").createTextFinder(String(coordId)).findNext();
    if (!range) { throw new Error('指定されたIDのコーデが見つかりません。'); }

    coordLogSheet.getRange(range.getRow(), 3).setValue(rating);
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
    const rowsToAdd = itemIds.map(itemId => {
      const newRowIndex = wearLogSheet.getLastRow() + 1;
      wearLogSheet.appendRow(['', itemId, timestamp]);
      const lastRow = wearLogSheet.getLastRow();
      wearLogSheet.getRange(lastRow, 1).setFormula(`=MAX(A$1:A${lastRow - 1}) + 1`);
    });
    return { status: 'success', message: `${itemIds.length}点の着用を記録しました！` };
  } catch (e) {
    console.error('logCoordinateWear Error: ' + e.stack);
    return { status: 'error', message: '着用記録に失敗しました。' };
  }
}

//----------------------------------------------------------------
// ヘルパー関数
//----------------------------------------------------------------

/**
 * ★新機能: 着用統計を取得するヘルパー関数
 * @param {string} itemId 対象のアイテムID
 * @returns {object} { total: number, byYear: object, history: array }
 */
function _getItemWearStats(itemId) {
  const wearLogLastRow = wearLogSheet.getLastRow();
  if (wearLogLastRow < 2) return { total: 0, byYear: {}, history: [] };

  const allWearLogs = wearLogSheet.getRange(2, 2, wearLogLastRow - 1, 2).getValues();
  const itemLogs = allWearLogs
    .filter(([id, date]) => id == itemId && date)
    .map(([id, date]) => new Date(date));

  if (itemLogs.length === 0) return { total: 0, byYear: {}, history: [] };
  
  const byYear = {};
  itemLogs.forEach(date => {
    const year = date.getFullYear();
    byYear[year] = (byYear[year] || 0) + 1;
  });

  const history = itemLogs
    .sort((a, b) => b - a) // 新しい順にソート
    .slice(0, 5)
    .map(date => Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd'));

  return { total: itemLogs.length, byYear, history };
}


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
        const itemIds = row[1].split(',');
        return {
          id: row[0],
          itemIds: itemIds,
          rating: row[2] || 0,
          items: itemIds.map(id => itemsById[id.trim()]).filter(Boolean),
          reason: row[4] || ''
        };
    });
}
