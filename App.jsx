import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Camera, ImagePlus, Settings, X, Download, Upload, 
  ChevronLeft, Trash2, Info, Loader2, Sparkles, 
  Shirt, CheckCircle2, AlertCircle, CalendarDays, 
  Archive, Plus, Edit3, Save, RotateCcw, Search,
  ChevronRight, BarChart3, Layers, Star, MessageCircle,
  Tags, Palette, Filter
} from 'lucide-react';

// ============================================================================
// 1. IndexedDB Wrapper (Local-First Database)
// ============================================================================
const DB_NAME = 'GigaClosetDB';
const DB_VERSION = 2;
const STORE_ITEMS = 'items';
const STORE_WEAR_LOGS = 'wear_logs';
const STORE_COORDS = 'coordinates';

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_WEAR_LOGS)) {
        const logStore = db.createObjectStore(STORE_WEAR_LOGS, { keyPath: 'id' });
        logStore.createIndex('date', 'date', { unique: false });
        logStore.createIndex('itemId', 'itemId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_COORDS)) db.createObjectStore(STORE_COORDS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const dbOp = async (storeName, mode, operation) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const getAllItems = () => dbOp(STORE_ITEMS, 'readonly', store => store.getAll());
const saveItem = (item) => dbOp(STORE_ITEMS, 'readwrite', store => store.put(item));
const deleteItem = (id) => dbOp(STORE_ITEMS, 'readwrite', store => store.delete(id));
const getAllWearLogs = () => dbOp(STORE_WEAR_LOGS, 'readonly', store => store.getAll());
const saveWearLog = (log) => dbOp(STORE_WEAR_LOGS, 'readwrite', store => store.put(log));
const deleteWearLog = (id) => dbOp(STORE_WEAR_LOGS, 'readwrite', store => store.delete(id));
const getAllCoords = () => dbOp(STORE_COORDS, 'readonly', store => store.getAll());
const saveCoord = (coord) => dbOp(STORE_COORDS, 'readwrite', store => store.put(coord));
const deleteCoord = (id) => dbOp(STORE_COORDS, 'readwrite', store => store.delete(id));

// ============================================================================
// 2. Image Processing & Gemini API Utils
// ============================================================================
const compressImage = (file, maxSide = 800, quality = 0.7) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      
      if (width > height) {
        if (width > maxSide) { height = Math.round((height * maxSide) / width); width = maxSide; }
      } else {
        if (height > maxSide) { width = Math.round((width * maxSide) / height); height = maxSide; }
      }
      
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像の読み込みに失敗しました')); };
    img.src = url;
  });
};

const analyzeImageWithGemini = async (base64Data, apiKey, customCategories, customColors) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const base64Str = base64Data.split(',')[1];
  
  const categoryDesc = customCategories && customCategories.length > 0 
    ? `カテゴリ（以下のリストから最も適切なものを1つ選んでください。該当がない場合は「未分類」としてください: ${customCategories.join(', ')}）`
    : `カテゴリ（トップス, ボトムス, アウター, 靴等）`;
  const colorDesc = customColors && customColors.length > 0
    ? `主な色（以下のリストから最も適切なものを1つ選んでください: ${customColors.join(', ')}）`
    : `主な色`;

  const schema = {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "アイテムの簡潔な名前" },
      category: { type: "STRING", description: categoryDesc },
      color: { type: "STRING", description: colorDesc },
      seasons: { type: "ARRAY", items: { type: "STRING" }, description: "適した季節（春, 夏, 秋, 冬）" },
      material: { type: "STRING", description: "推測される素材" },
      coordinate: { type: "STRING", description: "おすすめのコーディネート" },
      advice: { type: "STRING", description: "手入れや洗濯の際のアドバイス" }
    },
    required: ["name", "category", "color", "seasons", "material", "coordinate", "advice"]
  };

  const payload = {
    contents: [{ parts: [
      { text: "あなたはプロのスタイリストです。この衣類画像を解析し、JSON形式で詳細を抽出してください。カテゴリと色は、指定されたリストがある場合は必ずその中から選んでください。" },
      { inlineData: { mimeType: "image/jpeg", data: base64Str } }
    ]}],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema }
  };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `API Error: ${response.status}`);
  }
  
  try {
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('解析結果が空です');
    const parsed = JSON.parse(text);
    return {
      name: parsed.name || '名称未設定',
      category: parsed.category || '未分類',
      color: parsed.color || '-',
      seasons: Array.isArray(parsed.seasons) ? parsed.seasons : [],
      material: parsed.material || '-',
      coordinate: parsed.coordinate || '',
      advice: parsed.advice || ''
    };
  } catch (err) {
    throw new Error('画像の解析に失敗しました。');
  }
};

const askGeminiChat = async (question, imageBase64, chatHistory, items, coords, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const wardrobe = items.map(i => `- ${i.name} (${i.category}, ${i.color}, ${i.seasons?.join('/')})`).join('\n');
  const favCoords = coords.filter(c => c.rating >= 4).map(c => `- ` + c.itemIds.map(id => items.find(i=>i.id===id)?.name).filter(Boolean).join(' と ')).join('\n');

  const systemPrompt = `あなたは私の専属ファッションスタイリストです。以下の情報を参考に、私の質問に回答してください。
# 指示
- 質問に対して、具体的かつ簡潔に回答してください。
- 挨拶や結びの言葉は不要です。
- 私のワードローブにあるアイテムを組み合わせた提案を積極的に行ってください。
- 画像が添付された場合は、その画像の内容を踏まえて回答してください。

# 私のワードローブ
${wardrobe || 'アイテムなし'}

# 私の好きなコーデの傾向 (高評価)
${favCoords || 'まだありません'}`;

  const contents = chatHistory.map(msg => {
    const parts = [{ text: msg.text }];
    if (msg.image) parts.push({ inlineData: { mimeType: "image/jpeg", data: msg.image.split(',')[1] } });
    return { role: msg.role === 'user' ? 'user' : 'model', parts };
  });

  const currentParts = [{ text: question }];
  if (imageBase64) currentParts.push({ inlineData: { mimeType: "image/jpeg", data: imageBase64.split(',')[1] } });
  contents.push({ role: 'user', parts: currentParts });

  const payload = { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: contents };

  let retryCount = 0;
  while (retryCount < 3) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '回答を生成できませんでした。';
    } catch (err) {
      retryCount++;
      if (retryCount >= 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * retryCount));
    }
  }
};

const askGeminiStylist = async (baseItem, requestText, items, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const wardrobe = items.map(i => `ID:${i.id}, ${i.name} (${i.category}, ${i.color}, ${i.seasons?.join('/')})`).join('\n');
  const schema = {
    type: "OBJECT",
    properties: {
      suggestions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            itemIds: { type: "ARRAY", items: { type: "STRING" }, description: "コーデを構成するアイテムのID配列（基準アイテムIDを含む）" },
            reason: { type: "STRING", description: "提案理由" }
          },
          required: ["itemIds", "reason"]
        }
      }
    },
    required: ["suggestions"]
  };

  const prompt = `あなたはプロのファッションスタイリストです。以下の手持ちの服のみを使用し、基準アイテムに合うコーデを最大3つ提案してください。存在しないIDは含めないでください。\n# 今回の要望\n${requestText || '特になし'}\n# 基準アイテム\nID:${baseItem.id}, ${baseItem.name}\n# 手持ちの服\n${wardrobe}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{"suggestions":[]}');
  return parsed.suggestions || [];
};

const askGeminiStopper = async (imageBase64, items, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const wardrobe = items.map(i => `- ${i.name} (${i.category}, ${i.color})`).join('\n');
  
  const prompt = `あなたは辛口で優秀なファッションコンサルタントです。
ユーザーがお店で買おうか迷っている服の画像が添付されています。
以下の『ユーザーの手持ちの服リスト』を分析し、以下の3点についてアドバイスしてください。
1. この服を買うメリット（手持ちとどう合うかなど）
2. 買わない方がいい理由（手持ちの〇〇と似ている、着回しにくいなど、ストッパーとしての客観的な意見）
3. 最終的な結論（買うべき、見送るべき）

ユーザーの無駄遣いを防ぐため、少しでも懸念があれば「見送るべき」と厳しくアドバイスしてください。

# ユーザーの手持ちの服リスト
${wardrobe || 'アイテムなし'}`;

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: imageBase64.split(',')[1] } }
      ]
    }]
  };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '判定できませんでした。';
};

const askGeminiReverseLookup = async (imageBase64, items, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
  const wardrobe = items.map(i => `ID:${i.id}, ${i.name} (${i.category}, ${i.color})`).join('\n');
  
  const schema = {
    type: "OBJECT",
    properties: {
      reason: { type: "STRING", description: "提案理由や、元の画像とどう雰囲気を合わせたかの解説" },
      itemIds: { type: "ARRAY", items: { type: "STRING" }, description: "コーデを構成するアイテムのID配列" }
    },
    required: ["reason", "itemIds"]
  };

  const prompt = `あなたはプロのスタイリストです。
ユーザーが見つけた理想のコーデ（街角スナップなど）の画像が添付されています。
以下の『ユーザーの手持ちの服リスト』の中から、この画像のコーデの雰囲気を最もよく再現できるアイテムの組み合わせを提案してください。
存在しないIDは絶対に含めないでください。最低2つ以上のアイテムを組み合わせてください。

# ユーザーの手持ちの服リスト
${wardrobe || 'アイテムなし'}`;

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: imageBase64.split(',')[1] } }
      ]
    }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema }
  };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{"reason":"提案できませんでした。","itemIds":[]}');
};

// ============================================================================
// 3. UI Components (商用レベルの共通UI)
// ============================================================================
function FadeImage({ src, alt, className }) {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <div className={`relative overflow-hidden bg-gray-100 ${className}`}>
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="animate-spin text-gray-300" size={20} />
        </div>
      )}
      <img
        src={src}
        alt={alt || ''}
        className={`w-full h-full object-cover transition-opacity duration-500 ease-out ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setIsLoaded(true)}
        loading="lazy"
      />
    </div>
  );
}

function ConfirmModal({ isOpen, title, message, confirmText, cancelText, onConfirm, onCancel, isDestructive }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-6 whitespace-pre-wrap leading-relaxed">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-3.5 bg-gray-100 text-gray-700 font-bold rounded-xl hover:bg-gray-200 active:scale-95 transition-all focus:outline-none focus:ring-2 focus:ring-gray-300">
            {cancelText || 'キャンセル'}
          </button>
          <button onClick={onConfirm} className={`flex-1 py-3.5 font-bold rounded-xl text-white active:scale-95 transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-1 ${isDestructive ? 'bg-red-500 hover:bg-red-600 focus:ring-red-500' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'}`}>
            {confirmText || 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 4. Main React Application
// ============================================================================
export default function App() {
  const [items, setItems] = useState([]);
  const [wearLogs, setWearLogs] = useState([]);
  const [coords, setCoords] = useState([]);
  const [activeTab, setActiveTab] = useState('closet');
  const [activeView, setActiveView] = useState('main');
  const [selectedItem, setSelectedItem] = useState(null);
  const [aiStylistTargetId, setAiStylistTargetId] = useState(null); // AIスタイリストの基準アイテムを保持するState
  
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('giga_closet_api_key') || '');
  const [customCategories, setCustomCategories] = useState(() => {
    const saved = localStorage.getItem('giga_closet_custom_categories');
    return saved ? JSON.parse(saved) : ['トップス', 'ボトムス', 'アウター', '靴', 'バッグ', 'アクセサリー', '帽子', 'その他'];
  });
  const [customColors, setCustomColors] = useState(() => {
    const saved = localStorage.getItem('giga_closet_custom_colors');
    return saved ? JSON.parse(saved) : ['ホワイト', 'ブラック', 'グレー', 'ネイビー', 'ブルー', 'ブラウン', 'ベージュ', 'レッド', 'グリーン', 'イエロー', 'その他'];
  });

  const [toast, setToast] = useState({ show: false, message: '', type: 'info' });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const dbItems = await getAllItems();
      const dbLogs = await getAllWearLogs();
      const dbCoords = await getAllCoords();
      setItems(dbItems.sort((a, b) => b.createdAt - a.createdAt));
      setWearLogs(dbLogs);
      setCoords(dbCoords.sort((a, b) => b.createdAt - a.createdAt));
    } catch (err) {
      showToast('データの読み込みに失敗しました', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const showToast = (message, type = 'info') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'info' }), 4000);
  };

  const activeItems = useMemo(() => items.filter(i => !i.disposedAt), [items]);
  const disposedItems = useMemo(() => items.filter(i => i.disposedAt), [items]);

  return (
    <div className="h-[100dvh] w-full bg-gray-50 text-gray-800 font-sans selection:bg-blue-200 flex justify-center overflow-hidden overscroll-none">
      {/* Toast */}
      {toast.show && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-5 w-[90%] max-w-sm pointer-events-none">
          <div className={`flex items-start gap-3 px-5 py-4 rounded-2xl shadow-xl text-sm font-medium text-white
            ${toast.type === 'error' ? 'bg-red-500' : toast.type === 'success' ? 'bg-emerald-500' : 'bg-gray-800'}`}>
            {toast.type === 'error' ? <AlertCircle size={20} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={20} className="shrink-0 mt-0.5" />}
            <p className="break-words leading-relaxed">{toast.message}</p>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col relative">
        {/* Header */}
        <header className="shrink-0 px-5 py-3.5 flex items-center justify-between border-b border-gray-100 bg-white/90 backdrop-blur-md z-30">
          <div className="flex items-center gap-3">
            {activeView !== 'main' ? (
              <button 
                onClick={() => setActiveView('main')} 
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 active:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-100"
                aria-label="戻る"
              >
                <ChevronLeft size={24} />
              </button>
            ) : (
              <div className="bg-blue-600 p-1.5 rounded-xl shadow-sm shadow-blue-200">
                <Shirt className="text-white" size={22} strokeWidth={2.5} />
              </div>
            )}
            <h1 className="text-lg font-bold tracking-tight text-gray-900">
              {activeView === 'main' ? 'デジタルワードローブ' : activeView === 'add' ? 'アイテム追加' : activeView === 'disposed' ? '廃棄済み' : activeView === 'chat' ? 'AI相談室' : 'アイテム詳細'}
            </h1>
          </div>
          {activeView === 'main' && activeTab === 'closet' && (
            <div className="flex items-center gap-1.5">
              <button 
                onClick={() => {
                  if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); setActiveTab('settings'); return; }
                  setActiveView('chat');
                }}
                className="p-2.5 rounded-full hover:bg-gray-100 active:bg-gray-200 text-gray-600 transition-all active:scale-95 focus:outline-none"
                aria-label="AI相談室を開く"
              >
                <MessageCircle size={22} />
              </button>
              <button 
                onClick={() => setActiveView('add')}
                className="p-2.5 rounded-full bg-gray-900 text-white hover:bg-gray-800 active:bg-gray-700 transition-all shadow-sm active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-900"
                aria-label="アイテムを追加する"
              >
                <Plus size={22} />
              </button>
            </div>
          )}
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto relative bg-gray-50/50 overscroll-y-contain">
          {activeView === 'main' && (
            <div className="animate-in fade-in duration-300 pb-6">
              {activeTab === 'closet' && (
                <ClosetView 
                  items={activeItems} isLoading={isLoading} 
                  onItemClick={(item) => { setSelectedItem(item); setActiveView('detail'); }} 
                  onOpenAiStylist={(id) => {
                    if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); setActiveTab('settings'); return; }
                    setAiStylistTargetId(id);
                    setActiveTab('coord');
                  }}
                />
              )}
              {activeTab === 'coord' && (
                <CoordView 
                  items={activeItems} coords={coords} setCoords={setCoords} showToast={showToast} apiKey={apiKey} 
                  initialAiTargetId={aiStylistTargetId} clearAiTargetId={() => setAiStylistTargetId(null)}
                />
              )}
              {activeTab === 'calendar' && (
                <CalendarView items={activeItems} wearLogs={wearLogs} setWearLogs={setWearLogs} showToast={showToast} />
              )}
              {activeTab === 'stats' && (
                <StatsView activeItems={activeItems} disposedItems={disposedItems} wearLogs={wearLogs} />
              )}
              {activeTab === 'settings' && (
                <SettingsView 
                  apiKey={apiKey} setApiKey={setApiKey} 
                  customCategories={customCategories} setCustomCategories={setCustomCategories}
                  customColors={customColors} setCustomColors={setCustomColors}
                  showToast={showToast} onDataImported={loadData} onOpenDisposed={() => setActiveView('disposed')} 
                />
              )}
            </div>
          )}

          {activeView === 'disposed' && (
             <div className="animate-in slide-in-from-right-4 fade-in duration-300 h-full pb-6">
               <DisposedView 
                 items={disposedItems} 
                 showToast={showToast}
                 onRestore={async (item) => {
                   const updated = { ...item, disposedAt: null };
                   await saveItem(updated);
                   setItems(items.map(i => i.id === item.id ? updated : i));
                   showToast('クローゼットに戻しました', 'success');
                 }} 
                 onPermanentDelete={async (id) => {
                   await deleteItem(id);
                   setItems(prev => prev.filter(i => i.id !== id));
                   showToast('データを完全に削除しました', 'success');
                 }}
               />
             </div>
          )}

          {activeView === 'chat' && (
             <div className="animate-in slide-in-from-bottom-4 fade-in duration-300 h-full">
               <AIChatView items={activeItems} coords={coords} setCoords={setCoords} apiKey={apiKey} showToast={showToast} />
             </div>
          )}

          {activeView === 'add' && (
            <div className="animate-in slide-in-from-bottom-4 fade-in duration-300 h-full pb-6">
              <AddView 
                apiKey={apiKey} customCategories={customCategories} customColors={customColors} showToast={showToast}
                onSuccess={(item) => {
                  setItems(prev => [item, ...prev]);
                  showToast('追加しました', 'success');
                  setActiveView('main');
                }}
              />
            </div>
          )}

          {activeView === 'detail' && selectedItem && (
            <div className="animate-in slide-in-from-right-4 fade-in duration-300 h-full pb-6">
              <DetailView 
                item={selectedItem} items={activeItems} coords={coords} customCategories={customCategories} customColors={customColors} showToast={showToast}
                wearLogs={wearLogs}
                onUpdate={async (updatedItem) => {
                  await saveItem(updatedItem);
                  setItems(items.map(i => i.id === updatedItem.id ? updatedItem : i));
                  setSelectedItem(updatedItem);
                  showToast('保存しました', 'success');
                }}
                onDispose={async (item) => {
                  const updated = { ...item, disposedAt: Date.now() };
                  await saveItem(updated);
                  setItems(items.map(i => i.id === item.id ? updated : i));
                  showToast('廃棄済みに移動しました', 'success');
                  setActiveView('main');
                }}
              />
            </div>
          )}
        </main>

        {/* Bottom Navigation */}
        {activeView === 'main' && (
          <nav className="shrink-0 w-full bg-white border-t border-gray-100 flex justify-around pb-safe pt-1.5 px-2 z-40 shadow-[0_-8px_30px_rgba(0,0,0,0.04)]">
            <NavButton icon={<Shirt />} label="クローゼット" isActive={activeTab === 'closet'} onClick={() => setActiveTab('closet')} />
            <NavButton icon={<Layers />} label="コーデ" isActive={activeTab === 'coord'} onClick={() => setActiveTab('coord')} />
            <NavButton icon={<CalendarDays />} label="カレンダー" isActive={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} />
            <NavButton icon={<BarChart3 />} label="ダッシュボード" isActive={activeTab === 'stats'} onClick={() => setActiveTab('stats')} />
            <NavButton icon={<Settings />} label="設定" isActive={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
          </nav>
        )}
      </div>
    </div>
  );
}

function NavButton({ icon, label, isActive, onClick }) {
  return (
    <button 
      onClick={onClick} 
      className={`flex flex-col items-center py-2 px-1 min-w-[64px] transition-all duration-200 active:scale-95 select-none focus:outline-none ${isActive ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
      aria-label={`${label}タブ`}
    >
      <div className={`relative transition-transform duration-300 ${isActive ? 'scale-110' : 'scale-100'}`}>
        {React.cloneElement(icon, { size: 22, strokeWidth: isActive ? 2.5 : 2 })}
      </div>
      <span className={`text-[10px] mt-1.5 font-medium transition-all duration-200 ${isActive ? 'font-bold' : ''}`}>{label}</span>
    </button>
  );
}

// ==================== Closet View ====================
function ClosetView({ items, isLoading, onItemClick, onOpenAiStylist }) {
  const [filterCategory, setFilterCategory] = useState('すべて');
  const [filterColor, setFilterColor] = useState('すべて');
  const [filterSeason, setFilterSeason] = useState('すべて');
  const [filterYear, setFilterYear] = useState('すべて');
  const [sortOption, setSortOption] = useState('createdAt_desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  if (isLoading) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-gray-300" size={32} /></div>;

  const categories = ['すべて', ...new Set(items.map(item => item.category).filter(Boolean))];
  const colors = ['すべて', ...new Set(items.map(item => item.color).filter(Boolean))];
  const seasons = ['すべて', '春', '夏', '秋', '冬'];
  const years = ['すべて', ...new Set(items.map(item => item.purchaseYear).filter(Boolean).map(String))].sort((a,b) => b === 'すべて' ? 1 : a === 'すべて' ? -1 : Number(b) - Number(a));

  const filteredItems = useMemo(() => {
    let result = items.filter(item => {
      const matchSearch = !searchQuery || item.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.brand?.toLowerCase().includes(searchQuery.toLowerCase());
      const matchCat = filterCategory === 'すべて' || item.category === filterCategory;
      const matchColor = filterColor === 'すべて' || item.color === filterColor;
      const matchSeason = filterSeason === 'すべて' || (item.seasons && item.seasons.includes(filterSeason));
      const matchYear = filterYear === 'すべて' || String(item.purchaseYear) === String(filterYear);
      return matchSearch && matchCat && matchColor && matchSeason && matchYear;
    });

    result.sort((a, b) => {
      switch (sortOption) {
        case 'createdAt_desc': return b.createdAt - a.createdAt;
        case 'createdAt_asc': return a.createdAt - b.createdAt;
        case 'price_desc': return (Number(b.price) || 0) - (Number(a.price) || 0);
        case 'price_asc': return (Number(a.price) || 0) - (Number(b.price) || 0);
        case 'name_asc': return (a.name || '').localeCompare(b.name || '');
        case 'name_desc': return (b.name || '').localeCompare(a.name || '');
        default: return 0;
      }
    });
    return result;
  }, [items, searchQuery, filterCategory, filterColor, filterSeason, filterYear, sortOption]);

  const activeFiltersCount = (filterCategory !== 'すべて' ? 1 : 0) + (filterColor !== 'すべて' ? 1 : 0) + (filterSeason !== 'すべて' ? 1 : 0) + (filterYear !== 'すべて' ? 1 : 0);

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input 
            type="search" 
            placeholder="アイテム名やブランドで検索..." 
            className="w-full pl-10 pr-10 py-3 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-shadow placeholder:text-gray-400"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1">
              <X size={16} />
            </button>
          )}
        </div>
        <button 
          onClick={() => setIsFilterOpen(!isFilterOpen)}
          className={`relative p-3 rounded-xl border transition-all flex items-center justify-center active:scale-95 shadow-sm ${isFilterOpen || activeFiltersCount > 0 ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
          aria-label="絞り込みと並び替え"
        >
          <Filter size={20} />
          {activeFiltersCount > 0 && !isFilterOpen && (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white shadow-sm">
              {activeFiltersCount}
            </span>
          )}
        </button>
      </div>

      {isFilterOpen && (
        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm mb-4 space-y-4 animate-in fade-in slide-in-from-top-2 text-sm relative">
          <button onClick={() => setIsFilterOpen(false)} className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 p-1.5 bg-gray-50 hover:bg-gray-100 rounded-full transition-colors active:scale-95"><X size={18}/></button>
          <div className="pr-6">
            <label className="text-[11px] font-bold text-gray-500 mb-1.5 block">並び替え</label>
            <select value={sortOption} onChange={e => setSortOption(e.target.value)} className="w-full p-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium text-gray-700 appearance-none">
              <option value="createdAt_desc">登録日 (新しい順)</option>
              <option value="createdAt_asc">登録日 (古い順)</option>
              <option value="price_desc">価格 (高い順)</option>
              <option value="price_asc">価格 (安い順)</option>
              <option value="name_asc">名前 (昇順 A-Z)</option>
              <option value="name_desc">名前 (降順 Z-A)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-50">
            <div>
              <label className="text-[11px] font-bold text-gray-500 mb-1.5 block">カテゴリ</label>
              <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="w-full p-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700 truncate appearance-none">
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-gray-500 mb-1.5 block">色</label>
              <select value={filterColor} onChange={e => setFilterColor(e.target.value)} className="w-full p-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700 truncate appearance-none">
                {colors.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-gray-500 mb-1.5 block">シーズン</label>
              <select value={filterSeason} onChange={e => setFilterSeason(e.target.value)} className="w-full p-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700 appearance-none">
                {seasons.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-gray-500 mb-1.5 block">購入年</label>
              <select value={filterYear} onChange={e => setFilterYear(e.target.value)} className="w-full p-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700 appearance-none">
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          {(activeFiltersCount > 0 || sortOption !== 'createdAt_desc') && (
            <button 
              onClick={() => { setFilterCategory('すべて'); setFilterColor('すべて'); setFilterSeason('すべて'); setFilterYear('すべて'); setSortOption('createdAt_desc'); }}
              className="w-full py-3 mt-3 bg-gray-100 text-gray-700 rounded-xl text-xs font-bold hover:bg-gray-200 transition-colors active:scale-95"
            >
              条件と並び替えをリセット
            </button>
          )}
        </div>
      )}

      {!isFilterOpen && (
        <div className="flex overflow-x-auto pb-3 -mx-4 px-4 scrollbar-hide gap-2 mb-1">
          {categories.map(cat => (
            <button key={cat} onClick={() => setFilterCategory(cat)}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-xs font-bold transition-all active:scale-95 ${filterCategory === cat ? 'bg-gray-900 text-white shadow-md' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {cat}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-between items-center mb-3 px-1 mt-1">
        <p className="text-[11px] text-gray-500 font-bold bg-white border border-gray-200 px-2.5 py-1 rounded-lg shadow-sm">全 {filteredItems.length} 件</p>
      </div>

      {filteredItems.length === 0 ? (
        <div className="text-center py-20 px-4">
          <div className="bg-gray-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 text-gray-400"><Shirt size={36} strokeWidth={1.5} /></div>
          <p className="text-gray-500 font-medium">条件に合うアイテムがありません</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:gap-4">
          {filteredItems.map(item => (
            <div key={item.id} className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-all active:scale-[0.98] relative group" onClick={() => onItemClick(item)}>
              <FadeImage src={item.imageUrl} alt={item.name} className="aspect-square w-full border-b border-gray-50" />
              
              {/* アイテムから直接AIスタイリストを開くショートカットボタン */}
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenAiStylist) onOpenAiStylist(item.id);
                }}
                className="absolute top-2 right-2 p-2 bg-white/90 backdrop-blur-md text-blue-600 rounded-full shadow-sm hover:bg-white active:scale-95 transition-all opacity-95 hover:opacity-100"
                aria-label="このアイテムでAIスタイリストを実行"
              >
                <Sparkles size={16} strokeWidth={2.5} />
              </button>

              {sortOption.includes('price') && item.price && (
                <span className="absolute bottom-[4.5rem] left-2 px-2.5 py-1 bg-black/70 text-white text-[10px] font-bold rounded-lg backdrop-blur-md shadow-sm">
                  ¥{item.price.toLocaleString()}
                </span>
              )}
              <div className="p-3.5">
                <p className="text-[10px] font-bold text-blue-600 mb-1 line-clamp-1">{item.brand || item.category}</p>
                <h3 className="font-semibold text-gray-900 text-sm line-clamp-1 leading-snug">{item.name}</h3>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Detail & Edit View ====================
function DetailView({ item, items, coords, onUpdate, onDispose, customCategories, customColors, showToast, wearLogs }) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({ ...item });
  const [confirmDispose, setConfirmDispose] = useState(false);
  const fileInputRef = useRef(null);

  const wearCount = wearLogs ? wearLogs.filter(log => log.itemId === item.id).length : 0;
  const cpw = item.price ? Math.floor(item.price / Math.max(wearCount, 1)) : null;
  const relatedCoords = coords ? coords.filter(c => c.itemIds.includes(item.id)) : [];

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressedBase64 = await compressImage(file, 800, 0.7);
        setFormData({ ...formData, imageUrl: compressedBase64 });
      } catch (err) {
        showToast('画像の処理に失敗しました', 'error');
      }
    }
    e.target.value = '';
  };

  if (isEditing) {
    return (
      <div className="p-5 space-y-5 bg-white min-h-full animate-in fade-in">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-bold text-xl text-gray-900">アイテムの編集</h3>
          <button onClick={() => setIsEditing(false)} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 p-2 rounded-full transition-colors active:scale-95" aria-label="閉じる"><X size={24}/></button>
        </div>

        <div className="flex flex-col items-center gap-4 mb-6">
          <div className="relative w-36 h-36 rounded-3xl overflow-hidden bg-gray-50 border border-gray-200 group cursor-pointer shadow-sm" onClick={() => fileInputRef.current?.click()}>
            <img src={formData.imageUrl} alt="preview" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm">
              <Camera size={28} className="mb-1" />
              <span className="text-[11px] font-bold">画像を変更</span>
            </div>
          </div>
          <button onClick={() => fileInputRef.current?.click()} className="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 px-5 py-2.5 rounded-xl transition-colors shadow-sm">画像を選択し直す</button>
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleImageChange} />
        </div>

        <div className="space-y-4">
          <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">名前 <span className="text-red-500">*</span></label><input name="name" value={formData.name} onChange={handleChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">カテゴリ</label>
              <input name="category" value={formData.category} onChange={handleChange} list="category-list" className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" />
              <datalist id="category-list">{customCategories.map(cat => <option key={cat} value={cat} />)}</datalist>
            </div>
            <div>
              <label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">色</label>
              <input name="color" value={formData.color} onChange={handleChange} list="color-list" className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" />
              <datalist id="color-list">{customColors.map(color => <option key={color} value={color} />)}</datalist>
            </div>
          </div>
          <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">ブランド</label><input name="brand" value={formData.brand || ''} onChange={handleChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" placeholder="例: UNIQLO" /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">価格 (円)</label><input type="text" inputMode="numeric" pattern="[0-9]*" name="price" value={formData.price || ''} onChange={handleChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" placeholder="例: 3990" /></div>
            <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">購入年</label><input type="text" inputMode="numeric" pattern="[0-9]*" name="purchaseYear" value={formData.purchaseYear || ''} onChange={handleChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all placeholder:text-gray-400" placeholder="例: 2024" /></div>
          </div>
          <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">メモ</label><textarea name="memo" value={formData.memo || ''} onChange={handleChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all resize-none placeholder:text-gray-400" rows="3" placeholder="着心地やサイズ感など..." /></div>
        </div>
        <button 
          onClick={() => { 
            if(!formData.name.trim()) return; 
            const finalData = { ...formData, price: formData.price ? Number(String(formData.price).replace(/[^0-9]/g, '')) : null };
            onUpdate(finalData); 
            setIsEditing(false); 
          }} 
          disabled={!formData.name.trim()}
          className="w-full py-4 mt-8 bg-gray-900 text-white rounded-2xl font-bold flex justify-center items-center gap-2 active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100 shadow-md"
        >
          <Save size={20}/> 変更を保存する
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 min-h-full pb-10">
      <FadeImage src={item.imageUrl} alt={item.name} className="aspect-square w-full shadow-sm" />
      <div className="p-5 space-y-6 bg-white rounded-t-3xl -mt-6 relative z-10 shadow-[0_-10px_20px_rgba(0,0,0,0.03)]">
        <div className="flex justify-between items-start pt-2">
          <div>
            <p className="text-xs font-bold text-blue-600 mb-1.5 bg-blue-50 inline-block px-2.5 py-1 rounded-md">{item.brand ? `${item.brand} / ${item.category}` : item.category}</p>
            <h2 className="text-2xl font-extrabold leading-tight text-gray-900">{item.name}</h2>
          </div>
          <button onClick={() => setIsEditing(true)} className="p-2.5 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 rounded-full text-gray-600 transition-colors shadow-sm" aria-label="編集"><Edit3 size={20} /></button>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center mb-2">
          <div className="bg-gray-50 border border-gray-100 p-2.5 rounded-2xl"><p className="text-[10px] text-gray-500 font-medium mb-0.5">Price</p><p className="text-sm font-bold text-gray-800">{item.price ? `¥${item.price.toLocaleString()}` : '-'}</p></div>
          <div className="bg-gray-50 border border-gray-100 p-2.5 rounded-2xl"><p className="text-[10px] text-gray-500 font-medium mb-0.5">Wears</p><p className="text-sm font-bold text-gray-800">{wearCount} 回</p></div>
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-100 p-2.5 rounded-2xl shadow-inner">
            <p className="text-[10px] text-indigo-500 font-bold mb-0.5">CPW (1回あたり)</p>
            <p className="text-sm font-extrabold text-indigo-700">{cpw ? `¥${cpw.toLocaleString()}` : '-'}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-gray-50 border border-gray-100 p-2.5 rounded-2xl"><p className="text-[10px] text-gray-500 font-medium mb-0.5">Color</p><p className="text-sm font-bold text-gray-800">{item.color || '-'}</p></div>
          <div className="bg-gray-50 border border-gray-100 p-2.5 rounded-2xl"><p className="text-[10px] text-gray-500 font-medium mb-0.5">Season</p><p className="text-sm font-bold text-gray-800 truncate">{item.seasons?.join(',') || '-'}</p></div>
          <div className="bg-gray-50 border border-gray-100 p-2.5 rounded-2xl"><p className="text-[10px] text-gray-500 font-medium mb-0.5">Year</p><p className="text-sm font-bold text-gray-800">{item.purchaseYear || '-'}</p></div>
        </div>

        {item.memo && (
          <div className="bg-gray-50 border border-gray-100 p-4 rounded-2xl"><h3 className="text-xs font-bold text-gray-500 mb-1.5 flex items-center gap-1.5"><Info size={14}/> メモ</h3><p className="text-sm text-gray-700 leading-relaxed">{item.memo}</p></div>
        )}

        <div className="space-y-3 pt-2">
          {item.coordinate && (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 p-5 rounded-3xl border border-blue-100 shadow-sm relative overflow-hidden">
              <Sparkles className="absolute top-3 right-3 text-blue-200/50" size={60} strokeWidth={1} />
              <h3 className="font-bold text-blue-900 text-sm flex items-center gap-1.5 mb-2 relative z-10"><Sparkles size={16}/> AIコーデ提案</h3>
              <p className="text-blue-800 text-sm leading-relaxed relative z-10">{item.coordinate}</p>
            </div>
          )}
          {item.advice && (
            <div className="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm">
              <h3 className="font-bold text-gray-700 text-sm flex items-center gap-1.5 mb-2"><Info size={16} className="text-gray-400"/> お手入れ</h3>
              <p className="text-gray-600 text-sm leading-relaxed">{item.advice}</p>
            </div>
          )}
          
          {/* このアイテムを使ったマイコーデ一覧 */}
          {relatedCoords.length > 0 && (
            <div className="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm mt-3">
              <h3 className="font-bold text-gray-800 text-sm flex items-center gap-1.5 mb-3"><Layers size={16} className="text-blue-500"/> このアイテムを使ったコーデ</h3>
              <div className="space-y-3">
                {relatedCoords.map(coord => {
                  const coordItems = coord.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean);
                  if (coordItems.length === 0) return null;
                  return (
                    <div key={coord.id} className="bg-gray-50 p-3 rounded-2xl border border-gray-100">
                      {coord.reason && <p className="text-[10px] text-gray-500 font-medium mb-2 line-clamp-1">{coord.reason}</p>}
                      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
                        {coordItems.map(ci => (
                          <FadeImage key={ci.id} src={ci.imageUrl} alt="" className="w-14 h-14 rounded-xl shrink-0 border border-gray-200 shadow-sm" />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="pt-6">
          <button onClick={() => setConfirmDispose(true)} className="w-full py-4 text-red-500 font-bold bg-red-50 hover:bg-red-100 active:bg-red-200 rounded-2xl transition-colors flex items-center justify-center gap-2 shadow-sm"><Trash2 size={18} /> このアイテムを廃棄する</button>
        </div>
      </div>
      
      <ConfirmModal 
        isOpen={confirmDispose}
        title="アイテムの廃棄"
        message={`「${item.name}」を廃棄済みに移動しますか？\n（後で「設定」のアーカイブから戻すことも可能です）`}
        confirmText="廃棄する"
        isDestructive={true}
        onConfirm={() => { onDispose(item); setConfirmDispose(false); }}
        onCancel={() => setConfirmDispose(false)}
      />
    </div>
  );
}

// ==================== Calendar View ====================
function CalendarView({ items, wearLogs, setWearLogs, showToast }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDateStr, setSelectedDateStr] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState('すべて');

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();

  const logsByDate = useMemo(() => {
    const map = {};
    wearLogs.forEach(log => {
      if (!map[log.date]) map[log.date] = [];
      map[log.date].push(log);
    });
    return map;
  }, [wearLogs]);

  const handlePrevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const handleNextMonth = () => setCurrentDate(new Date(year, month + 1, 1));

  const selectDate = (day) => {
    const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setSelectedDateStr(dStr);
    setIsAdding(false);
    setFilter('すべて');
  };

  const addWearLog = async (item) => {
    if (!selectedDateStr) return;
    const newLog = { id: crypto.randomUUID(), itemId: item.id, date: selectedDateStr, createdAt: Date.now() };
    await saveWearLog(newLog);
    setWearLogs([...wearLogs, newLog]);
    setIsAdding(false);
    showToast('着用を記録しました', 'success');
  };

  const removeWearLog = async (logId) => {
    await deleteWearLog(logId);
    setWearLogs(wearLogs.filter(l => l.id !== logId));
  };

  const renderCalendarDays = () => {
    const days = [];
    const todayStr = new Date().toISOString().split('T')[0];

    for (let i = 0; i < firstDay; i++) days.push(<div key={`empty-${i}`} className="h-14 border-b border-r border-gray-100 bg-gray-50/30"></div>);
    
    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayLogs = logsByDate[dStr] || [];
      const isToday = dStr === todayStr;
      const isSelected = dStr === selectedDateStr;

      days.push(
        <div key={dStr} onClick={() => selectDate(d)} className={`h-14 border-b border-r border-gray-100 p-1 cursor-pointer transition-colors relative flex flex-col active:bg-blue-50
          ${isSelected ? 'bg-blue-50/60 shadow-inner' : 'bg-white hover:bg-gray-50'}`}>
          <span className={`text-[11px] font-bold w-5 h-5 flex items-center justify-center rounded-full ml-0.5 mt-0.5 ${isToday ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600'}`}>{d}</span>
          <div className="flex flex-wrap gap-0.5 mt-auto pb-0.5 px-0.5 justify-end">
            {dayLogs.slice(0, 3).map((log, i) => {
              const item = items.find(it => it.id === log.itemId);
              if (!item) return null;
              return <img key={i} src={item.imageUrl} alt="" className="w-4 h-4 object-cover rounded-sm shadow-sm ring-1 ring-white/50" loading="lazy" />;
            })}
            {dayLogs.length > 3 && <span className="text-[9px] text-gray-500 font-bold bg-gray-100 rounded-sm px-0.5">+{dayLogs.length - 3}</span>}
          </div>
        </div>
      );
    }
    return days;
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 p-3.5 flex justify-between items-center shadow-sm z-10">
        <button onClick={handlePrevMonth} className="p-2 hover:bg-gray-100 active:bg-gray-200 rounded-full transition-colors"><ChevronLeft size={22} className="text-gray-600"/></button>
        <h2 className="font-extrabold text-gray-900 text-lg tracking-tight">{year}年 {month + 1}月</h2>
        <button onClick={handleNextMonth} className="p-2 hover:bg-gray-100 active:bg-gray-200 rounded-full transition-colors"><ChevronRight size={22} className="text-gray-600"/></button>
      </div>
      
      <div className="bg-white">
        <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50/80">
          {['日','月','火','水','木','金','土'].map((d, i) => <div key={d} className={`text-center text-[10px] font-extrabold py-2.5 ${i===0 ? 'text-red-500': i===6 ? 'text-blue-500' : 'text-gray-500'}`}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 border-l border-gray-100">{renderCalendarDays()}</div>
      </div>

      {selectedDateStr && (
        <div className="p-5 bg-white flex-1 border-t border-gray-100 shadow-[0_-10px_30px_rgba(0,0,0,0.06)] z-20 animate-in slide-in-from-bottom-4 fade-in">
          <div className="flex justify-between items-center mb-5">
            <h3 className="font-extrabold text-gray-900 text-lg flex items-center gap-2">
              <CalendarDays className="text-blue-500" size={20}/>
              {selectedDateStr.split('-')[1]}月{selectedDateStr.split('-')[2]}日の記録
            </h3>
            {!isAdding && <button onClick={() => setIsAdding(true)} className="text-sm font-bold text-white bg-gray-900 hover:bg-gray-800 active:scale-95 px-4 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm"><Plus size={16}/>追加</button>}
          </div>

          {isAdding ? (
            <div className="space-y-4 animate-in fade-in">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-gray-500">着用したアイテムを選択</span>
                <button onClick={()=>setIsAdding(false)} className="text-xs font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors active:scale-95">キャンセル</button>
              </div>

              <div className="flex overflow-x-auto pb-2 -mx-2 px-2 scrollbar-hide gap-1.5">
                {['すべて', ...new Set(items.map(item => item.category).filter(Boolean))].map(cat => (
                  <button key={cat} onClick={() => setFilter(cat)}
                    className={`whitespace-nowrap px-3.5 py-2 rounded-full text-[11px] font-bold transition-all active:scale-95 ${filter === cat ? 'bg-gray-800 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {cat}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-2 max-h-56 overflow-y-auto pb-6 px-1">
                {items.filter(item => filter === 'すべて' || item.category === filter).map(item => (
                  <div key={item.id} onClick={() => addWearLog(item)} className="cursor-pointer group flex flex-col items-center active:scale-95 transition-all">
                    <FadeImage src={item.imageUrl} alt={item.name} className="w-16 h-16 rounded-2xl shadow-sm mb-1.5 group-hover:ring-2 group-hover:ring-blue-500 group-hover:shadow-md" />
                    <p className="text-[10px] text-center w-full truncate text-gray-600 group-hover:text-blue-700 font-semibold px-0.5">{item.name}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3 max-h-64 overflow-y-auto pr-1 pb-4">
              {logsByDate[selectedDateStr]?.length > 0 ? (
                logsByDate[selectedDateStr].map(log => {
                  const item = items.find(it => it.id === log.itemId);
                  if (!item) return null;
                  return (
                    <div key={log.id} className="flex items-center justify-between p-3 bg-white border border-gray-100 shadow-sm rounded-2xl group">
                      <div className="flex items-center gap-3.5">
                        <FadeImage src={item.imageUrl} alt="" className="w-12 h-12 rounded-xl" />
                        <div><p className="text-sm font-bold text-gray-900 leading-tight">{item.name}</p><p className="text-[11px] font-medium text-blue-600 mt-0.5">{item.category}</p></div>
                      </div>
                      <button onClick={() => removeWearLog(log.id)} className="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 rounded-full transition-colors" aria-label="記録を削除"><Trash2 size={18}/></button>
                    </div>
                  );
                })
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-gray-400">
                  <Shirt size={32} className="mb-2 opacity-50" />
                  <p className="text-sm font-medium">この日の着用記録はありません</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== Disposed View ====================
function DisposedView({ items, onRestore, onPermanentDelete, showToast }) {
  const [confirmRestoreId, setConfirmRestoreId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh] text-gray-400">
        <Archive size={56} className="mb-5 text-gray-300" strokeWidth={1.5} />
        <p className="font-bold text-gray-500">廃棄されたアイテムはありません</p>
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4">
      <h2 className="font-bold text-gray-800 px-1 mb-1">廃棄済みアイテム ({items.length})</h2>
      {items.map(item => (
        <div key={item.id} className="flex gap-4 bg-white p-4 rounded-3xl shadow-sm border border-gray-100">
          <FadeImage src={item.imageUrl} alt="" className="w-24 h-24 rounded-2xl opacity-50 grayscale" />
          <div className="flex-1 flex flex-col justify-center">
            <h3 className="font-bold text-gray-900 text-sm leading-snug">{item.name}</h3>
            <p className="text-[11px] font-medium text-gray-500 mb-3 mt-1">廃棄日: {new Date(item.disposedAt).toLocaleDateString()}</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmRestoreId(item.id)} className="flex-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 active:scale-95 py-2 rounded-xl flex items-center justify-center gap-1 transition-all"><RotateCcw size={14}/> 戻す</button>
              <button onClick={() => setConfirmDeleteId(item.id)} className="flex-1 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 active:scale-95 py-2 rounded-xl flex items-center justify-center gap-1 transition-all"><Trash2 size={14}/> 削除</button>
            </div>
          </div>
        </div>
      ))}
      <ConfirmModal isOpen={!!confirmRestoreId} title="復元" message="このアイテムをクローゼットに戻しますか？" confirmText="戻す" onConfirm={() => { onRestore(items.find(i=>i.id===confirmRestoreId)); setConfirmRestoreId(null); }} onCancel={() => setConfirmRestoreId(null)} />
      <ConfirmModal isOpen={!!confirmDeleteId} title="完全削除" message="本当にこのデータを削除しますか？\nこの操作は取り消せません。" confirmText="完全削除" isDestructive={true} onConfirm={() => { onPermanentDelete(confirmDeleteId); setConfirmDeleteId(null); }} onCancel={() => setConfirmDeleteId(null)} />
    </div>
  );
}

// ==================== Coord View ====================
function CoordView({ items, coords, setCoords, showToast, apiKey, initialAiTargetId, clearAiTargetId }) {
  const [isCreating, setIsCreating] = useState(false);
  const [isAiMode, setIsAiMode] = useState(!!initialAiTargetId);
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleteId, setDeleteId] = useState(null);

  useEffect(() => {
    if (initialAiTargetId) setIsAiMode(true);
  }, [initialAiTargetId]);

  const handleCloseAiMode = () => {
    setIsAiMode(false);
    if (clearAiTargetId) clearAiTargetId();
  };

  const handleToggleSelect = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);

  const handleSaveCoord = async () => {
    if (selectedIds.length < 2) { showToast('2つ以上のアイテムを選択してください', 'error'); return; }
    const newCoord = { id: crypto.randomUUID(), itemIds: selectedIds, rating: 0, createdAt: Date.now() };
    await saveCoord(newCoord); setCoords([newCoord, ...coords]); setIsCreating(false); setSelectedIds([]); showToast('コーデを保存しました', 'success');
  };

  const handleRate = async (coord, rating) => {
    const updated = { ...coord, rating };
    await saveCoord(updated); setCoords(coords.map(c => c.id === coord.id ? updated : c));
  };

  if (isAiMode) return <AiStylistView items={items} coords={coords} setCoords={setCoords} showToast={showToast} apiKey={apiKey} onClose={handleCloseAiMode} initialBaseItemId={initialAiTargetId} />;

  if (isCreating) {
    return (
      <div className="p-4 flex flex-col h-full animate-in fade-in">
        <div className="flex justify-between items-center mb-5 bg-white p-3 rounded-2xl shadow-sm border border-gray-100 sticky top-0 z-10">
          <h2 className="font-bold text-gray-900 ml-1">アイテムを選択 <span className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md text-sm">{selectedIds.length}</span></h2>
          <div className="flex gap-2">
            <button onClick={() => {setIsCreating(false); setSelectedIds([]);}} className="px-4 py-2.5 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 active:scale-95 rounded-xl transition-all">キャンセル</button>
            <button onClick={handleSaveCoord} className="px-4 py-2.5 text-xs font-bold text-white bg-gray-900 hover:bg-gray-800 active:scale-95 rounded-xl transition-all shadow-sm">保存</button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 overflow-y-auto pb-20">
          {items.map(item => {
            const isSelected = selectedIds.includes(item.id);
            return (
              <div key={item.id} onClick={() => handleToggleSelect(item.id)} className={`relative aspect-square rounded-2xl overflow-hidden border-2 cursor-pointer transition-all active:scale-95 ${isSelected ? 'border-blue-500 shadow-md scale-95 ring-2 ring-blue-200' : 'border-transparent'}`}>
                <FadeImage src={item.imageUrl} alt="" className="w-full h-full" />
                {isSelected && <div className="absolute inset-0 bg-blue-600/20 backdrop-blur-[1px] flex items-center justify-center"><CheckCircle2 className="text-white drop-shadow-md" size={36} strokeWidth={2.5} /></div>}
              </div>
            )
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-5">
        <h2 className="font-bold text-gray-900">マイコーデ ({coords.length})</h2>
        <div className="flex gap-2">
          <button onClick={() => { if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); return; } setIsAiMode(true); }} className="text-[11px] font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 active:scale-95 px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm"><Sparkles size={14}/>AI提案</button>
          <button onClick={() => setIsCreating(true)} className="text-[11px] font-bold text-white bg-gray-900 hover:bg-gray-800 active:scale-95 px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm"><Plus size={14}/>新規作成</button>
        </div>
      </div>
      
      {coords.length === 0 ? (
        <div className="text-center py-20">
          <Layers size={56} className="mx-auto text-gray-300 mb-4" strokeWidth={1.5} />
          <p className="text-gray-500 font-medium">保存されたコーディネートはありません</p>
        </div>
      ) : (
        <div className="space-y-4 pb-4">
          {coords.map(coord => {
            const coordItems = coord.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean);
            if(coordItems.length === 0) return null;
            return (
              <div key={coord.id} className="bg-white p-4 rounded-3xl shadow-sm border border-gray-100 group">
                {coord.reason && <p className="text-xs text-blue-800 bg-blue-50 p-2.5 rounded-xl mb-3 font-medium flex gap-2 items-start"><Sparkles size={14} className="shrink-0 mt-0.5"/> <span>{coord.reason}</span></p>}
                <div className="flex gap-2.5 overflow-x-auto pb-3 scrollbar-hide">
                  {coordItems.map(item => <FadeImage key={item.id} src={item.imageUrl} alt="" className="w-20 h-20 rounded-2xl shrink-0 border border-gray-100 shadow-sm" />)}
                </div>
                <div className="flex justify-between items-center mt-1 border-t border-gray-50 pt-3">
                  <div className="flex gap-1.5">
                    {[1,2,3,4,5].map(star => <Star key={star} onClick={() => handleRate(coord, star)} size={22} className={`cursor-pointer transition-all active:scale-110 ${coord.rating >= star ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200 hover:text-gray-300'}`} />)}
                  </div>
                  <button onClick={() => setDeleteId(coord.id)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"><Trash2 size={18}/></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ConfirmModal isOpen={!!deleteId} title="コーデの削除" message="このコーディネートを削除しますか？" confirmText="削除" isDestructive={true} onConfirm={async () => { await deleteCoord(deleteId); setCoords(coords.filter(c => c.id !== deleteId)); showToast('削除しました', 'success'); setDeleteId(null); }} onCancel={() => setDeleteId(null)} />
    </div>
  );
}

// ==================== AI Stylist View ====================
function AiStylistView({ items, coords, setCoords, showToast, apiKey, onClose, initialBaseItemId }) {
  const [requestText, setRequestText] = useState('');
  const [baseItemId, setBaseItemId] = useState(initialBaseItemId || null);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (initialBaseItemId) setBaseItemId(initialBaseItemId);
  }, [initialBaseItemId]);

  const handleGenerate = async () => {
    if (!baseItemId) { showToast('基準にするアイテムを選んでください', 'error'); return; }
    setIsLoading(true);
    try {
      const baseItem = items.find(i => i.id === baseItemId);
      const results = await askGeminiStylist(baseItem, requestText, items, apiKey);
      const validResults = results.map(s => ({ ...s, itemIds: s.itemIds.filter(id => items.some(i => i.id === id)) })).filter(s => s.itemIds.length >= 2);
      if (validResults.length === 0) showToast('条件に合う提案が見つかりませんでした。', 'error');
      else setSuggestions(validResults);
    } catch (error) { showToast(error.message || 'AIの提案に失敗しました', 'error'); } finally { setIsLoading(false); }
  };

  const handleSaveSuggestion = async (suggestion) => {
    const newCoord = { id: crypto.randomUUID(), itemIds: suggestion.itemIds, rating: 0, reason: suggestion.reason, createdAt: Date.now() };
    await saveCoord(newCoord); setCoords(prev => [newCoord, ...prev]); showToast('コーデを保存しました', 'success');
    setSuggestions(prev => prev.filter(s => s !== suggestion));
  };

  return (
    <div className="p-4 flex flex-col h-full animate-in fade-in slide-in-from-bottom-4">
      <div className="flex justify-between items-center mb-5 bg-white p-3 rounded-2xl shadow-sm border border-gray-100">
        <h2 className="font-bold text-gray-900 ml-1 flex items-center gap-2"><Sparkles className="text-blue-500" size={18}/> AIスタイリスト</h2>
        <button onClick={onClose} className="px-4 py-2 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 active:scale-95 rounded-xl transition-colors">キャンセル</button>
      </div>
      
      <div className="space-y-6 flex-1 overflow-y-auto pb-10">
        <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
          <label className="text-xs font-bold text-gray-600 block mb-2">1. 要望 (任意)</label>
          <input type="text" value={requestText} onChange={e => setRequestText(e.target.value)} placeholder="例: デート用、少し寒めの日" className="w-full p-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" />
        </div>
        
        <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
           <label className="text-xs font-bold text-gray-600 block mb-3">2. 基準アイテム (1つ選択)</label>
           <div className="flex overflow-x-auto gap-2 pb-2 scrollbar-hide -mx-1 px-1">
              {items.map(item => (
                <div key={item.id} onClick={() => setBaseItemId(item.id)} className={`shrink-0 w-20 relative rounded-2xl overflow-hidden border-2 cursor-pointer transition-all active:scale-95 ${baseItemId === item.id ? 'border-blue-500 shadow-md ring-2 ring-blue-100 scale-95' : 'border-transparent bg-gray-50'}`}>
                  <FadeImage src={item.imageUrl} alt="" className="w-full aspect-square" />
                  {baseItemId === item.id && <div className="absolute inset-0 bg-blue-600/20 backdrop-blur-[1px] flex items-center justify-center"><CheckCircle2 className="text-white drop-shadow-md" size={28} strokeWidth={2.5}/></div>}
                </div>
              ))}
           </div>
        </div>

        <button onClick={handleGenerate} disabled={isLoading || !baseItemId} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 disabled:active:scale-100 active:scale-[0.98] transition-all shadow-md">
          {isLoading ? <Loader2 className="animate-spin" size={20} /> : <Sparkles size={20} />}
          {isLoading ? '提案を作成中...' : 'コーデを提案してもらう'}
        </button>

        {suggestions.length > 0 && (
          <div className="mt-8 space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <h3 className="font-extrabold text-gray-800 ml-1">提案結果</h3>
            {suggestions.map((s, idx) => (
              <div key={idx} className="bg-gradient-to-br from-white to-gray-50 p-5 rounded-3xl border border-gray-200 shadow-sm space-y-4">
                <p className="text-sm text-gray-700 font-medium leading-relaxed">{s.reason}</p>
                <div className="flex gap-2.5 overflow-x-auto pb-2 scrollbar-hide">
                  {s.itemIds.map(id => {
                    const item = items.find(i => i.id === id);
                    if (!item) return null;
                    return <FadeImage key={id} src={item.imageUrl} alt="" className="w-16 h-16 rounded-2xl border border-gray-100 shadow-sm shrink-0" />
                  })}
                </div>
                <button onClick={() => handleSaveSuggestion(s)} className="w-full py-3.5 bg-blue-600 text-white text-sm font-bold rounded-xl hover:bg-blue-700 active:scale-95 transition-all shadow-sm">保存する</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== Stats View (Dashboard) ====================
function StatsView({ activeItems, disposedItems, wearLogs }) {
  const activeTotal = activeItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const disposedTotal = disposedItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
  const allTotal = activeTotal + disposedTotal;
  const [rankCategory, setRankCategory] = useState('すべて');
  const categories = ['すべて', ...new Set(activeItems.map(item => item.category).filter(Boolean))];

  const wearCounts = wearLogs.reduce((acc, log) => { acc[log.itemId] = (acc[log.itemId] || 0) + 1; return acc; }, {});
  const wearRanking = Object.entries(wearCounts).map(([id, count]) => ({ item: activeItems.find(i => i.id === id), count })).filter(x => x.item && (rankCategory === 'すべて' || x.item.category === rankCategory)).sort((a, b) => b.count - a.count).slice(0, 5);
  const catCounts = activeItems.reduce((acc, item) => { const cat = item.category || '未分類'; acc[cat] = (acc[cat] || 0) + 1; return acc; }, {});
  const catRanking = Object.entries(catCounts).sort((a,b) => b[1] - a[1]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="font-extrabold text-gray-900 mb-2 px-1 text-xl">ダッシュボード</h2>
      
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
          <p className="text-[11px] font-bold text-gray-500 mb-1.5">アクティブアイテム</p>
          <p className="text-3xl font-extrabold text-gray-900">{activeItems.length}<span className="text-sm font-medium text-gray-400 ml-1">点</span></p>
        </div>
        <div className="bg-gray-50 p-5 rounded-3xl border border-gray-200 shadow-sm">
          <p className="text-[11px] font-bold text-gray-500 mb-1.5">廃棄済みアイテム</p>
          <p className="text-3xl font-extrabold text-gray-500">{disposedItems.length}<span className="text-sm font-medium text-gray-400 ml-1">点</span></p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-gray-900 to-gray-800 text-white p-6 rounded-3xl shadow-lg space-y-5 relative overflow-hidden">
        <div className="absolute -right-4 -top-4 opacity-10"><BarChart3 size={100} strokeWidth={3} /></div>
        <h3 className="text-sm font-bold text-gray-300 border-b border-white/10 pb-3 relative z-10">アイテムの資産状況</h3>
        <div className="grid grid-cols-2 gap-4 relative z-10">
           <div><p className="text-[10px] font-bold text-gray-400 mb-1">現在のクローゼット</p><p className="text-xl font-bold">¥{activeTotal.toLocaleString()}</p></div>
           <div><p className="text-[10px] font-bold text-gray-400 mb-1">廃棄済み総額</p><p className="text-xl font-bold text-gray-300">¥{disposedTotal.toLocaleString()}</p></div>
        </div>
        <div className="pt-4 border-t border-white/10 relative z-10">
           <p className="text-xs font-bold text-gray-400 mb-1">累計投資総額</p>
           <p className="text-3xl font-extrabold tracking-tight">¥{allTotal.toLocaleString()}</p>
        </div>
      </div>

      <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-1.5"><BarChart3 size={18} className="text-blue-500"/> 着用回数 Top 5</h3>
          <select value={rankCategory} onChange={(e) => setRankCategory(e.target.value)} className="text-[11px] font-bold text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 appearance-none">
            {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </div>
        {wearRanking.length === 0 ? <p className="text-xs font-medium text-gray-400 text-center py-6">記録がありません</p> : (
          <div className="space-y-4">
            {wearRanking.map((rank, i) => (
              <div key={rank.item.id} className="flex items-center gap-3.5">
                <span className={`text-sm font-extrabold w-5 text-center ${i===0?'text-yellow-500':i===1?'text-gray-400':i===2?'text-amber-700':'text-gray-300'}`}>{i+1}</span>
                <FadeImage src={rank.item.imageUrl} alt="" className="w-12 h-12 rounded-xl shadow-sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate mb-1.5">{rank.item.name}</p>
                  <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                    <div className="bg-blue-500 h-full rounded-full transition-all duration-1000 ease-out" style={{ width: `${Math.min((rank.count / wearRanking[0].count) * 100, 100)}%` }}></div>
                  </div>
                </div>
                <span className="text-sm font-extrabold text-blue-600 w-8 text-right">{rank.count}<span className="text-[10px] text-gray-400 ml-0.5">回</span></span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <h3 className="text-sm font-bold text-gray-800 mb-4">カテゴリ別割合 (アクティブ)</h3>
        <div className="space-y-3">
          {catRanking.map(([cat, count]) => (
            <div key={cat} className="flex items-center justify-between text-sm">
              <span className="text-gray-600 font-medium w-24 truncate">{cat}</span>
              <div className="flex-1 flex items-center gap-3 ml-2">
                <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div className="bg-gray-800 h-full rounded-full" style={{ width: `${(count / activeItems.length) * 100}%` }}></div>
                </div>
                <span className="text-gray-900 font-bold w-8 text-right">{count}<span className="text-[10px] text-gray-400 font-normal ml-0.5">点</span></span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==================== Add View (Camera/AI) ====================
function AddView({ apiKey, customCategories, customColors, showToast, onSuccess }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [step, setStep] = useState(1);
  const [isManual, setIsManual] = useState(!apiKey);
  const [formData, setFormData] = useState({ name: '', category: '', color: '', brand: '', price: '', purchaseYear: '', memo: '' });
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (selected) { setFile(selected); setPreview(URL.createObjectURL(selected)); setIsManual(!apiKey); }
  };

  const processImage = async () => {
    if (!file || !apiKey) return;
    setIsProcessing(true); setStep(2);
    try {
      const compressedBase64 = await compressImage(file);
      const metadata = await analyzeImageWithGemini(compressedBase64, apiKey, customCategories, customColors);
      const newItem = { id: crypto.randomUUID(), imageUrl: compressedBase64, createdAt: Date.now(), disposedAt: null, ...metadata };
      await saveItem(newItem); onSuccess(newItem);
    } catch (err) { showToast(err.message || 'エラーが発生しました', 'error'); setStep(1); } finally { setIsProcessing(false); }
  };

  const handleManualSave = async () => {
    if (!formData.name.trim()) { showToast('名前を入力してください', 'error'); return; }
    setIsProcessing(true);
    try {
      const compressedBase64 = await compressImage(file);
      const newItem = { id: crypto.randomUUID(), imageUrl: compressedBase64, createdAt: Date.now(), disposedAt: null, ...formData, price: formData.price ? Number(String(formData.price).replace(/[^0-9]/g, '')) : null };
      await saveItem(newItem); onSuccess(newItem);
    } catch(err) { showToast('保存に失敗しました', 'error'); } finally { setIsProcessing(false); }
  };

  const handleFormChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  return (
    <div className="p-5">
      {step === 1 && (
        <div className="space-y-6">
          {!preview ? (
            <div className="grid grid-cols-2 gap-4">
              <button onClick={() => cameraInputRef.current?.click()} className="flex flex-col items-center justify-center p-10 bg-white rounded-3xl border border-gray-200 shadow-sm hover:border-blue-400 hover:bg-blue-50 active:scale-95 transition-all text-gray-500 hover:text-blue-600">
                <Camera size={42} className="mb-3" strokeWidth={1.5} />
                <span className="font-bold text-sm">カメラ</span>
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center p-10 bg-white rounded-3xl border border-gray-200 shadow-sm hover:border-blue-400 hover:bg-blue-50 active:scale-95 transition-all text-gray-500 hover:text-blue-600">
                <ImagePlus size={42} className="mb-3" strokeWidth={1.5} />
                <span className="font-bold text-sm">写真を選択</span>
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="relative rounded-3xl overflow-hidden bg-gray-50 aspect-square w-full shadow-md border border-gray-200">
                <img src={preview} alt="" className="w-full h-full object-contain" />
                <button onClick={() => { setFile(null); setPreview(null); }} className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 active:scale-95 text-white p-2.5 rounded-full transition-all backdrop-blur-sm" aria-label="画像を削除"><X size={20} /></button>
              </div>
              
              {!isManual ? (
                <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                  <button onClick={processImage} disabled={isProcessing} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold text-lg shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"><Sparkles size={20} /> AIで解析して保存</button>
                  <button onClick={() => setIsManual(true)} className="w-full py-4 bg-white border border-gray-200 text-gray-700 rounded-2xl font-bold shadow-sm flex items-center justify-center gap-2 active:scale-95 transition-all hover:bg-gray-50"><Edit3 size={18} /> 手動で情報を入力して保存</button>
                </div>
              ) : (
                <div className="bg-white p-6 rounded-3xl border border-gray-200 shadow-sm space-y-5 animate-in fade-in slide-in-from-bottom-2">
                  <h3 className="font-extrabold text-gray-900 border-b border-gray-100 pb-3 text-lg">手動入力</h3>
                  <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">名前 <span className="text-red-500">*</span></label><input name="name" value={formData.name} onChange={handleFormChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" placeholder="例: 白いTシャツ" /></div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">カテゴリ</label><input name="category" value={formData.category} onChange={handleFormChange} list="add-category-list" className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" placeholder="例: トップス" /><datalist id="add-category-list">{customCategories.map(cat => <option key={cat} value={cat} />)}</datalist></div>
                    <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">色</label><input name="color" value={formData.color} onChange={handleFormChange} list="add-color-list" className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" placeholder="例: ホワイト" /><datalist id="add-color-list">{customColors.map(color => <option key={color} value={color} />)}</datalist></div>
                  </div>
                  <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">ブランド</label><input name="brand" value={formData.brand} onChange={handleFormChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" placeholder="例: UNIQLO" /></div>
                  <div><label className="text-[11px] font-bold text-gray-500 ml-1 mb-1 block">価格 (円)</label><input type="text" inputMode="numeric" pattern="[0-9]*" name="price" value={formData.price} onChange={handleFormChange} className="w-full p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow placeholder:text-gray-400" placeholder="例: 3990" /></div>
                  
                  <div className="flex gap-3 pt-2">
                    {apiKey && <button onClick={() => setIsManual(false)} className="flex-1 py-3.5 bg-gray-100 text-gray-700 rounded-xl font-bold active:scale-95 transition-all">戻る</button>}
                    <button onClick={handleManualSave} disabled={isProcessing || !formData.name.trim()} className="flex-[2] py-3.5 bg-gray-900 text-white rounded-xl font-bold active:scale-95 disabled:opacity-50 transition-all flex justify-center items-center gap-1.5 shadow-sm"><Save size={18}/> 保存する</button>
                  </div>
                </div>
              )}
            </div>
          )}
          <input type="file" ref={cameraInputRef} accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleFileChange} />
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col items-center justify-center py-32"><div className="relative w-24 h-24 mb-8"><div className="absolute inset-0 border-4 border-gray-100 rounded-full"></div><div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div><div className="absolute inset-0 flex items-center justify-center text-blue-600"><Sparkles size={32} className="animate-pulse" /></div></div><h3 className="text-xl font-extrabold text-gray-900 mb-2">AIが解析中...</h3><p className="text-sm text-gray-500">色や素材を判定しています</p></div>
      )}
    </div>
  );
}

// ==================== Settings View ====================
function SettingsView({ apiKey, setApiKey, customCategories, setCustomCategories, customColors, setCustomColors, showToast, onDataImported, onOpenDisposed }) {
  const [localKey, setLocalKey] = useState(apiKey);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditingCategories, setIsEditingCategories] = useState(false);
  const [categoriesText, setCategoriesText] = useState(customCategories.join(', '));
  const [isEditingColors, setIsEditingColors] = useState(false);
  const [colorsText, setColorsText] = useState(customColors.join(', '));
  const [confirmImport, setConfirmImport] = useState(false);
  const [importFiles, setImportFiles] = useState(null);
  const fileInputRef = useRef(null);

  const handleSaveKey = () => { localStorage.setItem('giga_closet_api_key', localKey); setApiKey(localKey); showToast('保存しました', 'success'); };

  const handleSaveCategories = () => {
    const newCategories = categoriesText.split(',').map(s => s.trim()).filter(Boolean);
    if(newCategories.length === 0) { showToast('カテゴリを1つ以上入力してください', 'error'); return; }
    setCustomCategories(newCategories); localStorage.setItem('giga_closet_custom_categories', JSON.stringify(newCategories)); setIsEditingCategories(false); showToast('カテゴリを保存しました', 'success');
  };

  const handleSaveColors = () => {
    const newColors = colorsText.split(',').map(s => s.trim()).filter(Boolean);
    if(newColors.length === 0) { showToast('色を1つ以上入力してください', 'error'); return; }
    setCustomColors(newColors); localStorage.setItem('giga_closet_custom_colors', JSON.stringify(newColors)); setIsEditingColors(false); showToast('色を保存しました', 'success');
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const items = await getAllItems(); const wearLogs = await getAllWearLogs(); const coords = await getAllCoords();
      const backupData = { items, wearLogs, coords };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `digital_wardrobe_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast('バックアップをダウンロードしました', 'success');
    } catch (err) { showToast('エクスポートに失敗しました', 'error'); } finally { setIsExporting(false); }
  };

  const executeImport = async () => {
    if (!importFiles || importFiles.length === 0) return;
    setConfirmImport(false);
    showToast('データをインポート中...', 'info');
    try {
      let importedItemsCount = 0;
      for (const file of importFiles) {
        const text = await file.text();
        const backupData = JSON.parse(text);
        const items = Array.isArray(backupData) ? backupData : (backupData.items || []);
        const wearLogs = backupData.wearLogs || [];
        const coords = backupData.coords || [];
        for (const item of items) { if (item.id && item.imageUrl) await saveItem(item); }
        for (const log of wearLogs) { if (log.id && log.itemId) await saveWearLog(log); }
        for (const coord of coords) { if (coord.id && coord.itemIds) await saveCoord(coord); }
        importedItemsCount += items.length;
      }
      showToast(`復元が完了しました（アイテム計: ${importedItemsCount}件）`, 'success');
      onDataImported();
    } catch (err) { showToast('インポートに失敗しました。正しいJSONか確認してください', 'error'); }
    if(fileInputRef.current) fileInputRef.current.value = '';
    setImportFiles(null);
  };

  return (
    <div className="p-4 space-y-5 pb-10">
      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <h3 className="font-bold mb-3 flex items-center gap-2 text-gray-800"><Settings size={18} className="text-gray-400"/> Gemini APIキー</h3>
        <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="AIzaSy..." className="w-full px-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl mb-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button onClick={handleSaveKey} className="w-full py-3.5 bg-gray-900 text-white rounded-xl font-bold text-sm hover:bg-gray-800 active:scale-95 transition-all shadow-sm">保存する</button>
      </section>

      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-5">
        <div>
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold flex items-center gap-2 text-gray-800"><Tags size={18} className="text-blue-500"/> カスタムカテゴリ</h3>
            {!isEditingCategories && <button onClick={() => setIsEditingCategories(true)} className="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 active:scale-95 px-3 py-1.5 rounded-lg transition-all">編集</button>}
          </div>
          {!isEditingCategories ? (
            <div className="flex flex-wrap gap-1.5">
              {customCategories.map(cat => <span key={cat} className="px-3 py-1.5 bg-gray-50 border border-gray-200 text-gray-700 font-medium text-[11px] rounded-lg shadow-sm">{cat}</span>)}
            </div>
          ) : (
            <div className="space-y-3 animate-in fade-in">
              <p className="text-[10px] text-gray-500 leading-tight">カンマ（ , ）区切りで入力してください。</p>
              <textarea value={categoriesText} onChange={(e) => setCategoriesText(e.target.value)} className="w-full p-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" rows="3" />
              <div className="flex gap-2">
                <button onClick={() => {setIsEditingCategories(false); setCategoriesText(customCategories.join(', '));}} className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-xs font-bold active:scale-95 transition-all">キャンセル</button>
                <button onClick={handleSaveCategories} className="flex-[2] py-2.5 bg-gray-900 text-white rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm">保存</button>
              </div>
            </div>
          )}
        </div>

        <div className="pt-5 border-t border-gray-50">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold flex items-center gap-2 text-gray-800"><Palette size={18} className="text-amber-500"/> カスタムカラー</h3>
            {!isEditingColors && <button onClick={() => setIsEditingColors(true)} className="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 active:scale-95 px-3 py-1.5 rounded-lg transition-all">編集</button>}
          </div>
          {!isEditingColors ? (
            <div className="flex flex-wrap gap-1.5">
              {customColors.map(color => <span key={color} className="px-3 py-1.5 bg-gray-50 border border-gray-200 text-gray-700 font-medium text-[11px] rounded-lg shadow-sm">{color}</span>)}
            </div>
          ) : (
            <div className="space-y-3 animate-in fade-in">
              <p className="text-[10px] text-gray-500 leading-tight">カンマ（ , ）区切りで入力してください。</p>
              <textarea value={colorsText} onChange={(e) => setColorsText(e.target.value)} className="w-full p-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" rows="3" />
              <div className="flex gap-2">
                <button onClick={() => {setIsEditingColors(false); setColorsText(customColors.join(', '));}} className="flex-1 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-xs font-bold active:scale-95 transition-all">キャンセル</button>
                <button onClick={handleSaveColors} className="flex-[2] py-2.5 bg-gray-900 text-white rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm">保存</button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
         <h3 className="font-bold mb-3 flex items-center gap-2 text-gray-800"><Archive size={18} className="text-gray-400"/> アーカイブ</h3>
         <button onClick={onOpenDisposed} className="w-full py-4 bg-gray-50 hover:bg-gray-100 active:scale-[0.98] text-gray-700 rounded-2xl font-bold text-sm border border-gray-200 transition-all flex justify-between items-center px-5 shadow-sm">
           廃棄済みアイテムを確認
           <ChevronRight size={18} className="text-gray-400" />
         </button>
      </section>

      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <h3 className="font-bold mb-2 text-gray-800">データ管理</h3>
        <p className="text-[11px] text-gray-500 mb-5 leading-relaxed">全てのデータはブラウザ内に保存されています。機種変更時はエクスポートして移行してください。</p>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={handleExport} disabled={isExporting} className="flex flex-col items-center justify-center py-5 bg-blue-50 hover:bg-blue-100 active:scale-95 text-blue-700 rounded-2xl transition-all border border-blue-100 disabled:opacity-50 shadow-sm">
            <Download size={26} className="mb-2" strokeWidth={1.5} />
            <span className="font-bold text-sm">エクスポート</span>
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center py-5 bg-emerald-50 hover:bg-emerald-100 active:scale-95 text-emerald-700 rounded-2xl transition-all border border-emerald-100 shadow-sm">
            <Upload size={26} className="mb-2" strokeWidth={1.5} />
            <span className="font-bold text-sm">インポート</span>
          </button>
          <input type="file" ref={fileInputRef} multiple accept="application/json,.json,text/plain,*/*" className="hidden" onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) { setImportFiles(files); setConfirmImport(true); }
          }} />
        </div>
      </section>
      
      <ConfirmModal isOpen={confirmImport} title="データのインポート" message={`選択された ${importFiles?.length} 個のファイルからデータを復元しますか？\n（既存のデータは保持されます）`} confirmText="復元する" onConfirm={executeImport} onCancel={() => { setConfirmImport(false); setImportFiles(null); if(fileInputRef.current) fileInputRef.current.value = ''; }} />
    </div>
  );
}

// ==================== AIChat View ====================
function AIChatView({ items, coords, setCoords, apiKey, showToast }) {
  const [messages, setMessages] = useState([{ role: 'model', text: 'こんにちは！あなたの専属スタイリストです。手持ちのアイテムを使ったコーデの提案や、買い足すべきアイテムのアドバイスなど、何でも聞いてください。\n\n「買わないストッパー」や「逆引きコーデ」も下のボタンから使えますよ！' }]);
  const [input, setInput] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [chatMode, setChatMode] = useState('normal'); // 'normal' | 'stopper' | 'reverse'
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, isLoading]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressedBase64 = await compressImage(file, 800, 0.7);
        setSelectedImage(compressedBase64);
      } catch (err) { showToast('画像の処理に失敗しました', 'error'); }
    }
    e.target.value = '';
  };

  const handleTextareaChange = (e) => {
    setInput(e.target.value);
    e.target.style.height = '44px';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const handleSend = async () => {
    if ((!input.trim() && !selectedImage) || !apiKey) return;
    if ((chatMode === 'stopper' || chatMode === 'reverse') && !selectedImage) {
      showToast('このモードでは対象となる画像の添付が必須です', 'error');
      return;
    }
    
    let defaultText = 'この画像についてどう思いますか？';
    if (chatMode === 'stopper') defaultText = 'この服、買うべきですか？';
    if (chatMode === 'reverse') defaultText = 'このスナップのコーデを手持ちの服で再現してください！';

    const textToSend = input.trim() || defaultText;
    const userMsg = { role: 'user', text: textToSend, image: selectedImage, mode: chatMode };
    
    setMessages(prev => [...prev, userMsg]); setInput(''); setSelectedImage(null); setIsLoading(true);
    const textarea = document.getElementById('chat-textarea'); if (textarea) textarea.style.height = '44px';

    try {
      if (chatMode === 'stopper') {
        const reply = await askGeminiStopper(userMsg.image, items, apiKey);
        setMessages(prev => [...prev, { role: 'model', text: reply }]);
      } else if (chatMode === 'reverse') {
        const result = await askGeminiReverseLookup(userMsg.image, items, apiKey);
        const validItemIds = (result.itemIds || []).filter(id => items.some(i => i.id === id));
        if (validItemIds.length < 2) throw new Error('手持ちの服では再現が難しかったようです。');
        setMessages(prev => [...prev, { role: 'model', text: result.reason, itemIds: validItemIds }]);
      } else {
        const apiHistory = messages.filter((m, i) => i !== 0 && !m.itemIds); 
        const reply = await askGeminiChat(textToSend, userMsg.image, apiHistory, items, coords, apiKey);
        setMessages(prev => [...prev, { role: 'model', text: reply }]);
      }
    } catch (err) { 
      showToast(err.message || 'AIの応答に失敗しました', 'error'); 
    } finally { 
      setIsLoading(false); 
    }
  };

  const handleSaveReverseCoord = async (itemIds, reason) => {
    const newCoord = { id: crypto.randomUUID(), itemIds, rating: 0, reason: "街角スナップから再現: " + reason, createdAt: Date.now() };
    await saveCoord(newCoord);
    setCoords(prev => [newCoord, ...prev]);
    showToast('マイコーデに保存しました！', 'success');
  };

  const modeColors = {
    normal: 'bg-blue-600',
    stopper: 'bg-red-500',
    reverse: 'bg-purple-600'
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 pb-safe">
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-4 rounded-3xl shadow-sm ${msg.role === 'user' ? `${modeColors[msg.mode || 'normal']} text-white rounded-tr-sm` : 'bg-white border border-gray-100 rounded-tl-sm text-gray-800'}`}>
              {msg.image && <img src={msg.image} alt="attached" className="max-w-full h-auto rounded-xl mb-3 object-contain max-h-48 border border-black/5" />}
              {msg.text && <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{msg.text}</p>}
              
              {/* 逆引きコーデの保存UI */}
              {msg.itemIds && (
                <div className="mt-4 bg-gray-50 p-3 rounded-2xl border border-gray-100">
                  <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                    {msg.itemIds.map(id => {
                      const item = items.find(i => i.id === id);
                      if (!item) return null;
                      return <FadeImage key={id} src={item.imageUrl} alt="" className="w-14 h-14 rounded-xl shrink-0 shadow-sm border border-gray-200" />;
                    })}
                  </div>
                  <button 
                    onClick={() => handleSaveReverseCoord(msg.itemIds, msg.text)}
                    className="w-full mt-2 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold rounded-xl active:scale-95 transition-all shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <Save size={14}/> 提案をマイコーデに保存
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-100 shadow-sm p-4 rounded-3xl rounded-tl-sm">
              <Loader2 className="animate-spin text-blue-500" size={20} />
            </div>
          </div>
        )}
      </div>
      
      <div className="bg-white border-t border-gray-100 shadow-[0_-10px_20px_rgba(0,0,0,0.03)] flex flex-col z-10 pt-2">
        {/* モード切替タブ */}
        <div className="flex gap-2 px-4 pb-1 overflow-x-auto scrollbar-hide">
          <button onClick={() => setChatMode('normal')} className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all active:scale-95 ${chatMode === 'normal' ? 'bg-blue-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>💬 相談</button>
          <button onClick={() => setChatMode('stopper')} className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all active:scale-95 ${chatMode === 'stopper' ? 'bg-red-500 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>🛑 買わないストッパー</button>
          <button onClick={() => setChatMode('reverse')} className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold transition-all active:scale-95 ${chatMode === 'reverse' ? 'bg-purple-600 text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>🔍 逆引きコーデ</button>
        </div>

        {selectedImage && (
          <div className="px-4 pt-2 relative inline-block self-start">
            <div className="relative">
              <img src={selectedImage} alt="preview" className="h-16 w-16 object-cover rounded-xl border border-gray-200 shadow-sm" />
              <button onClick={() => setSelectedImage(null)} className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full p-1.5 shadow-md hover:bg-gray-700 active:scale-95 transition-all"><X size={12} strokeWidth={3}/></button>
            </div>
          </div>
        )}
        <div className="p-3 flex gap-2 items-end">
          <button onClick={() => fileInputRef.current?.click()} className="p-3 text-gray-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 active:scale-95 rounded-xl transition-all shrink-0 mb-0.5" aria-label="画像を添付"><ImagePlus size={24} strokeWidth={1.5} /></button>
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleFileSelect} />
          <textarea id="chat-textarea" value={input} onChange={handleTextareaChange} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} placeholder={chatMode === 'stopper' ? "この服買うべき？(画像必須)" : chatMode === 'reverse' ? "このコーデを再現して！(画像必須)" : "AIに相談する..."} className="flex-1 px-4 py-3.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow resize-none overflow-y-auto" rows="1" style={{ minHeight: '48px', height: '48px' }} />
          <button onClick={handleSend} disabled={isLoading || (!input.trim() && !selectedImage)} className={`p-3 text-white rounded-xl active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-all shrink-0 mb-0.5 shadow-sm ${modeColors[chatMode]}`} aria-label="送信"><Sparkles size={22} /></button>
        </div>
      </div>
    </div>
  );
}
