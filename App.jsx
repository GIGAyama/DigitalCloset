import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Camera, ImagePlus, Settings, X, Download, Upload, 
  ChevronLeft, Trash2, Info, Loader2, Sparkles, 
  Shirt, CheckCircle2, AlertCircle, CalendarDays, 
  Archive, Plus, Edit3, Save, RotateCcw, Search,
  ChevronRight, BarChart3, Layers, Star, MessageCircle
} from 'lucide-react';

// ============================================================================
// 1. IndexedDB Wrapper (Local-First Database)
// v2: wear_logs(着用ログ) と coordinates(コーデ) 用のストアを追加
// ============================================================================
const DB_NAME = 'GigaClosetDB';
const DB_VERSION = 2; // バージョンアップ
const STORE_ITEMS = 'items';
const STORE_WEAR_LOGS = 'wear_logs';
const STORE_COORDS = 'coordinates';

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_WEAR_LOGS)) {
        const logStore = db.createObjectStore(STORE_WEAR_LOGS, { keyPath: 'id' });
        logStore.createIndex('date', 'date', { unique: false });
        logStore.createIndex('itemId', 'itemId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_COORDS)) {
        db.createObjectStore(STORE_COORDS, { keyPath: 'id' });
      }
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

// Items API
const getAllItems = () => dbOp(STORE_ITEMS, 'readonly', store => store.getAll());
const saveItem = (item) => dbOp(STORE_ITEMS, 'readwrite', store => store.put(item));
const deleteItem = (id) => dbOp(STORE_ITEMS, 'readwrite', store => store.delete(id));

// Wear Logs API
const getAllWearLogs = () => dbOp(STORE_WEAR_LOGS, 'readonly', store => store.getAll());
const saveWearLog = (log) => dbOp(STORE_WEAR_LOGS, 'readwrite', store => store.put(log));
const deleteWearLog = (id) => dbOp(STORE_WEAR_LOGS, 'readwrite', store => store.delete(id));

// Coords API
const getAllCoords = () => dbOp(STORE_COORDS, 'readonly', store => store.getAll());
const saveCoord = (coord) => dbOp(STORE_COORDS, 'readwrite', store => store.put(coord));
const deleteCoord = (id) => dbOp(STORE_COORDS, 'readwrite', store => store.delete(id));

// ============================================================================
// 2. Image Processing & Gemini API Utils
// ============================================================================
// スマホのメモリ不足対策：FileReaderではなくURL.createObjectURLを使用し、解像度を800pxに最適化
const compressImage = (file, maxSide = 800, quality = 0.7) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    
    img.onload = () => {
      URL.revokeObjectURL(url); // メモリ解放
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      
      if (width > height) {
        if (width > maxSide) { height = Math.round((height * maxSide) / width); width = maxSide; }
      } else {
        if (height > maxSide) { width = Math.round((width * maxSide) / height); height = maxSide; }
      }
      
      canvas.width = width; 
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; 
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像の読み込みに失敗しました'));
    };
    
    img.src = url;
  });
};

const analyzeImageWithGemini = async (base64Data, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const base64Str = base64Data.split(',')[1];
  const schema = {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "アイテムの簡潔な名前" },
      category: { type: "STRING", description: "カテゴリ（トップス, ボトムス, アウター, 靴等）" },
      color: { type: "STRING", description: "主な色" },
      seasons: { type: "ARRAY", items: { type: "STRING" }, description: "適した季節（春, 夏, 秋, 冬）" },
      material: { type: "STRING", description: "推測される素材" },
      coordinate: { type: "STRING", description: "おすすめのコーディネート" },
      advice: { type: "STRING", description: "手入れや洗濯の際のアドバイス" }
    },
    required: ["name", "category", "color", "seasons", "material", "coordinate", "advice"]
  };

  const payload = {
    contents: [{ parts: [
      { text: "あなたはプロのスタイリストです。この衣類画像を解析し、JSON形式で詳細を抽出してください。" },
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
    // パース結果の堅牢性を担保（プロパティの欠落を防ぐ）
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
    console.error("AI Analysis Error:", err);
    throw new Error('画像の解析に失敗しました。');
  }
};

const askGeminiChat = async (question, imageBase64, chatHistory, items, coords, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const wardrobe = items.map(i => `- ${i.name} (${i.category}, ${i.color}, ${i.seasons?.join('/')})`).join('\n');
  const favCoords = coords.filter(c => c.rating >= 4).map(c => `- ` + c.itemIds.map(id => items.find(i=>i.id===id)?.name).filter(Boolean).join(' と ')).join('\n');

  const systemPrompt = `あなたは私の専属ファッションスタイリストです。以下の情報を参考に、私の質問に回答してください。
# 指示
- 質問に対して、具体的かつ簡潔に回答してください。
- 挨拶や結びの言葉は不要です。
- 私のワードローブにあるアイテムを組み合わせた提案を積極的に行ってください。
- 画像が添付された場合は、その画像の内容（買い足したいアイテム、試着室での写真など）を踏まえて回答してください。

# 私のワードローブ
${wardrobe || 'アイテムなし'}

# 私の好きなコーデの傾向 (高評価)
${favCoords || 'まだありません'}`;

  const contents = chatHistory.map(msg => {
    const parts = [{ text: msg.text }];
    if (msg.image) {
      const base64Str = msg.image.split(',')[1];
      parts.push({ inlineData: { mimeType: "image/jpeg", data: base64Str } });
    }
    return { role: msg.role === 'user' ? 'user' : 'model', parts };
  });

  const currentParts = [{ text: question }];
  if (imageBase64) {
    const base64Str = imageBase64.split(',')[1];
    currentParts.push({ inlineData: { mimeType: "image/jpeg", data: base64Str } });
  }
  contents.push({ role: 'user', parts: currentParts });

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents
  };

  let retryCount = 0;
  while (retryCount < 3) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `API Error: ${response.status}`);
      }
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || 'すみません、回答を生成できませんでした。';
    } catch (err) {
      retryCount++;
      if (retryCount >= 3) throw err;
      await new Promise(r => setTimeout(r, 1000 * retryCount));
    }
  }
};

const askGeminiStylist = async (baseItem, requestText, items, apiKey) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
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

  const prompt = `あなたはプロのファッションスタイリストです。
以下の「手持ちの服リスト」のアイテムのみを使用して、「基準アイテム」に合うコーディネートを最大3つ提案してください。
提案するアイテムIDは、必ず「手持ちの服リスト」に存在するものを使用してください。存在しないIDは絶対に含めないでください。
「今回の要望」がある場合は、それを最優先で考慮してください。

# 今回の要望
${requestText || '特になし'}

# 基準アイテム
ID:${baseItem.id}, ${baseItem.name}

# 手持ちの服リスト
${wardrobe}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `API Error: ${response.status}`);
  }
  const data = await response.json();
  const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{"suggestions":[]}');
  return parsed.suggestions || [];
};

// ============================================================================
// 4. Main React Application
// ============================================================================
export default function App() {
  const [items, setItems] = useState([]);
  const [wearLogs, setWearLogs] = useState([]);
  const [coords, setCoords] = useState([]);
  const [activeTab, setActiveTab] = useState('closet'); // closet, coord, calendar, stats, settings
  const [activeView, setActiveView] = useState('main'); // main, add, detail, disposed, chat
  const [selectedItem, setSelectedItem] = useState(null);
  
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('giga_closet_api_key') || '');
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
    setTimeout(() => setToast({ show: false, message: '', type: 'info' }), 5000); // エラーが読みやすいように5秒に延長
  };

  // 廃棄フラグでフィルタリング (パフォーマンス最適化のためメモ化)
  const activeItems = useMemo(() => items.filter(i => !i.disposedAt), [items]);
  const disposedItems = useMemo(() => items.filter(i => i.disposedAt), [items]);

  return (
    // 変更: h-[100dvh] を指定し、スマホの動的なビューポートに高さを完全一致させる
    <div className="h-[100dvh] w-full bg-gray-50 text-gray-800 font-sans selection:bg-blue-200 flex justify-center overflow-hidden">
      {/* Toast */}
      {toast.show && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-5 w-[90%] max-w-sm">
          <div className={`flex items-start gap-2 px-4 py-3 rounded-2xl shadow-lg text-sm font-medium text-white
            ${toast.type === 'error' ? 'bg-red-500' : toast.type === 'success' ? 'bg-emerald-500' : 'bg-gray-800'}`}>
            {toast.type === 'error' ? <AlertCircle size={18} className="shrink-0 mt-0.5" /> : <CheckCircle2 size={18} className="shrink-0 mt-0.5" />}
            <p className="break-words leading-relaxed">{toast.message}</p>
          </div>
        </div>
      )}

      {/* Mobile-first Container (flex flex-col h-full に変更) */}
      <div className="w-full max-w-md bg-white h-full shadow-2xl overflow-hidden relative flex flex-col">
        
        {/* Header (shrink-0 を追加し、高さを固定) */}
        <header className="shrink-0 px-5 py-4 flex items-center justify-between border-b border-gray-100 bg-white/90 backdrop-blur-md z-30">
          <div className="flex items-center gap-2">
            {activeView !== 'main' ? (
              <button 
                onClick={() => setActiveView('main')} 
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 active:bg-gray-200 transition-colors"
                aria-label="戻る"
              >
                <ChevronLeft size={24} />
              </button>
            ) : (
              <div className="bg-blue-600 p-1.5 rounded-lg shadow-sm">
                <Shirt className="text-white" size={20} strokeWidth={2.5} />
              </div>
            )}
            <h1 className="text-lg font-bold tracking-tight text-gray-900">
              {activeView === 'main' ? 'GIGA Closet' : activeView === 'add' ? 'アイテム追加' : activeView === 'disposed' ? '廃棄済み' : activeView === 'chat' ? 'AI相談室' : 'アイテム詳細'}
            </h1>
          </div>
          {activeView === 'main' && activeTab === 'closet' && (
            <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); setActiveTab('settings'); return; }
                  setActiveView('chat');
                }}
                className="p-2 rounded-full hover:bg-gray-100 active:bg-gray-200 text-gray-600 transition-all shadow-sm active:scale-95"
                aria-label="AI相談室を開く"
              >
                <MessageCircle size={20} />
              </button>
              <button 
                onClick={() => {
                  if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); setActiveTab('settings'); return; }
                  setActiveView('add');
                }}
                className="p-2 rounded-full bg-gray-900 text-white hover:bg-gray-800 active:bg-gray-700 transition-all shadow-sm active:scale-95"
                aria-label="アイテムを追加する"
              >
                <Plus size={20} />
              </button>
            </div>
          )}
        </header>

        {/* Main Content Area (flex-1 overflow-y-auto でここだけがスクロールする) */}
        <main className="flex-1 overflow-y-auto relative bg-gray-50/50">
          {activeView === 'main' && (
            <div className="animate-in fade-in duration-300 pb-6">
              {activeTab === 'closet' && (
                <ClosetView 
                  items={activeItems} isLoading={isLoading} 
                  onItemClick={(item) => { setSelectedItem(item); setActiveView('detail'); }} 
                />
              )}
              {activeTab === 'coord' && (
                <CoordView items={activeItems} coords={coords} setCoords={setCoords} showToast={showToast} apiKey={apiKey} />
              )}
              {activeTab === 'calendar' && (
                <CalendarView items={activeItems} wearLogs={wearLogs} setWearLogs={setWearLogs} showToast={showToast} />
              )}
              {activeTab === 'stats' && (
                <StatsView items={activeItems} wearLogs={wearLogs} />
              )}
              {activeTab === 'settings' && (
                <SettingsView apiKey={apiKey} setApiKey={setApiKey} showToast={showToast} onDataImported={loadData} onOpenDisposed={() => setActiveView('disposed')} />
              )}
            </div>
          )}

          {activeView === 'disposed' && (
             <div className="animate-in slide-in-from-right-4 fade-in duration-300 h-full pb-6">
               <DisposedView 
                 items={disposedItems} 
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
               <AIChatView 
                 items={activeItems}
                 coords={coords}
                 apiKey={apiKey}
                 showToast={showToast}
               />
             </div>
          )}

          {activeView === 'add' && (
            <div className="animate-in slide-in-from-bottom-4 fade-in duration-300 h-full pb-6">
              <AddView 
                apiKey={apiKey} 
                showToast={showToast}
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
                item={selectedItem}
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

        {/* Bottom Navigation (shrink-0 を付与し、absolute を解除して完全固定) */}
        {activeView === 'main' && (
          <nav className="shrink-0 w-full bg-white border-t border-gray-100 flex justify-around pb-safe pt-2 px-2 z-40 shadow-[0_-4px_20px_rgba(0,0,0,0.02)]">
            <NavButton icon={<Shirt />} label="Closet" isActive={activeTab === 'closet'} onClick={() => setActiveTab('closet')} />
            <NavButton icon={<Layers />} label="Coord" isActive={activeTab === 'coord'} onClick={() => setActiveTab('coord')} />
            <NavButton icon={<CalendarDays />} label="Calendar" isActive={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} />
            <NavButton icon={<BarChart3 />} label="Dashboard" isActive={activeTab === 'stats'} onClick={() => setActiveTab('stats')} />
            <NavButton icon={<Settings />} label="Settings" isActive={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
          </nav>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Components
// ----------------------------------------------------------------------------
function NavButton({ icon, label, isActive, onClick }) {
  return (
    <button 
      onClick={onClick} 
      className={`flex flex-col items-center p-2 min-w-[64px] transition-all duration-200 active:scale-95 ${isActive ? 'text-blue-600' : 'text-gray-400 hover:text-gray-600'}`}
      aria-label={`${label}タブ`}
    >
      {React.cloneElement(icon, { size: 22, strokeWidth: isActive ? 2.5 : 2, className: isActive ? 'animate-in zoom-in duration-200' : '' })}
      <span className={`text-[10px] mt-1 font-medium ${isActive ? 'font-bold' : ''}`}>{label}</span>
    </button>
  );
}

// ==================== Closet View ====================
function ClosetView({ items, isLoading, onItemClick }) {
  const [filter, setFilter] = useState('すべて');
  const [searchQuery, setSearchQuery] = useState('');

  if (isLoading) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-gray-400" size={24} /></div>;

  const categories = ['すべて', ...new Set(items.map(item => item.category).filter(Boolean))];
  const filteredItems = items.filter(item => {
    const matchCat = filter === 'すべて' || item.category === filter;
    const matchSearch = item.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.brand?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div className="p-4">
      {/* Search & Filter */}
      <div className="mb-4 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input 
            type="text" 
            placeholder="アイテム名やブランドで検索..." 
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide gap-2">
          {categories.map(cat => (
            <button key={cat} onClick={() => setFilter(cat)}
              className={`whitespace-nowrap px-4 py-1.5 rounded-full text-xs font-bold transition-all ${filter === cat ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="text-center py-16 px-4">
          <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3 text-gray-400"><Shirt size={32} /></div>
          <p className="text-gray-500 text-sm">アイテムが見つかりません</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {filteredItems.map(item => (
            <div key={item.id} onClick={() => onItemClick(item)} className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100 cursor-pointer hover:shadow-md transition-shadow">
              <div className="aspect-square bg-gray-100"><img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" loading="lazy" /></div>
              <div className="p-3">
                <p className="text-[10px] font-bold text-blue-600 mb-0.5 line-clamp-1">{item.brand || item.category}</p>
                <h3 className="font-semibold text-gray-900 text-sm line-clamp-1">{item.name}</h3>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Detail & Edit View ====================
function DetailView({ item, onUpdate, onDispose }) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({ ...item });
  const fileInputRef = useRef(null);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressedBase64 = await compressImage(file, 800, 0.7);
        setFormData({ ...formData, imageUrl: compressedBase64 });
      } catch (err) {
        alert('画像の処理に失敗しました');
      }
    }
    e.target.value = '';
  };

  if (isEditing) {
    return (
      <div className="p-5 space-y-4 bg-white min-h-full animate-in fade-in">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-bold text-lg">アイテムの編集</h3>
          <button onClick={() => setIsEditing(false)} className="text-gray-500 hover:bg-gray-100 p-1.5 rounded-full transition-colors" aria-label="閉じる"><X size={24}/></button>
        </div>

        <div className="flex flex-col items-center gap-3 mb-4">
          <div className="relative w-32 h-32 rounded-2xl overflow-hidden bg-gray-100 border border-gray-200 group cursor-pointer" onClick={() => fileInputRef.current?.click()}>
            <img src={formData.imageUrl} alt="preview" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera size={24} className="mb-1" />
              <span className="text-[10px] font-bold">画像を変更</span>
            </div>
          </div>
          <button onClick={() => fileInputRef.current?.click()} className="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-xl transition-colors">画像を選択し直す</button>
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleImageChange} />
        </div>

        <div className="space-y-3">
          <div><label className="text-xs font-bold text-gray-500 ml-1">名前 <span className="text-red-500">*</span></label><input name="name" value={formData.name} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-bold text-gray-500 ml-1">カテゴリ</label><input name="category" value={formData.category} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" /></div>
            <div><label className="text-xs font-bold text-gray-500 ml-1">色</label><input name="color" value={formData.color} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" /></div>
          </div>
          <div><label className="text-xs font-bold text-gray-500 ml-1">ブランド</label><input name="brand" value={formData.brand || ''} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" placeholder="例: UNIQLO" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-bold text-gray-500 ml-1">価格 (円)</label><input type="number" name="price" value={formData.price || ''} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" /></div>
            <div><label className="text-xs font-bold text-gray-500 ml-1">購入年</label><input type="number" name="purchaseYear" value={formData.purchaseYear || ''} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow" /></div>
          </div>
          <div><label className="text-xs font-bold text-gray-500 ml-1">メモ</label><textarea name="memo" value={formData.memo || ''} onChange={handleChange} className="w-full p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none transition-shadow resize-none" rows="3" /></div>
        </div>
        <button 
          onClick={() => { 
            if(!formData.name.trim()) return; 
            onUpdate(formData); 
            setIsEditing(false); 
          }} 
          disabled={!formData.name.trim()}
          className="w-full py-4 mt-6 bg-gray-900 text-white rounded-xl font-bold flex justify-center items-center gap-2 active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"
        >
          <Save size={18}/> 保存する
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white min-h-full pb-10">
      <div className="relative aspect-square w-full bg-gray-100">
        <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
      </div>
      <div className="p-5 space-y-6">
        <div className="flex justify-between items-start">
          <div>
            <p className="text-xs font-bold text-blue-600 mb-1">{item.brand ? `${item.brand} / ${item.category}` : item.category}</p>
            <h2 className="text-2xl font-bold leading-tight text-gray-900">{item.name}</h2>
          </div>
          <button onClick={() => setIsEditing(true)} className="p-2 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 rounded-full text-gray-600 transition-colors" aria-label="編集"><Edit3 size={18} /></button>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="bg-gray-50 p-2 rounded-xl"><p className="text-[10px] text-gray-500">Color</p><p className="text-sm font-semibold">{item.color || '-'}</p></div>
          <div className="bg-gray-50 p-2 rounded-xl"><p className="text-[10px] text-gray-500">Season</p><p className="text-sm font-semibold">{item.seasons?.join(',') || '-'}</p></div>
          <div className="bg-gray-50 p-2 rounded-xl"><p className="text-[10px] text-gray-500">Price</p><p className="text-sm font-semibold">{item.price ? `¥${item.price}` : '-'}</p></div>
          <div className="bg-gray-50 p-2 rounded-xl"><p className="text-[10px] text-gray-500">Year</p><p className="text-sm font-semibold">{item.purchaseYear || '-'}</p></div>
        </div>

        {item.memo && (
          <div className="bg-gray-50 p-4 rounded-2xl"><h3 className="text-xs font-bold text-gray-500 mb-1">メモ</h3><p className="text-sm text-gray-700">{item.memo}</p></div>
        )}

        <div className="space-y-3">
          <div className="bg-blue-50 p-4 rounded-2xl border border-blue-100"><h3 className="font-bold text-blue-900 text-sm flex items-center gap-1.5 mb-1"><Sparkles size={16}/>AIコーデ提案</h3><p className="text-blue-800 text-sm leading-relaxed">{item.coordinate}</p></div>
          <div className="bg-gray-50 p-4 rounded-2xl border border-gray-100"><h3 className="font-bold text-gray-700 text-sm flex items-center gap-1.5 mb-1"><Info size={16}/>お手入れ</h3><p className="text-gray-600 text-sm leading-relaxed">{item.advice}</p></div>
        </div>

        <button onClick={() => { if(window.confirm('このアイテムを廃棄済みに移動しますか？')) onDispose(item); }} className="w-full py-3.5 text-red-500 font-bold bg-red-50 hover:bg-red-100 active:bg-red-200 rounded-xl transition-colors flex items-center justify-center gap-2 mt-4"><Trash2 size={18} /> 廃棄する</button>
      </div>
    </div>
  );
}

// ==================== Calendar View ====================
function CalendarView({ items, wearLogs, setWearLogs, showToast }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDateStr, setSelectedDateStr] = useState(null);
  const [isAdding, setIsAdding] = useState(false);

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

    for (let i = 0; i < firstDay; i++) days.push(<div key={`empty-${i}`} className="h-12 border-b border-r border-gray-100 bg-gray-50/50"></div>);
    
    for (let d = 1; d <= daysInMonth; d++) {
      const dStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayLogs = logsByDate[dStr] || [];
      const isToday = dStr === todayStr;
      const isSelected = dStr === selectedDateStr;

      days.push(
        <div key={dStr} onClick={() => selectDate(d)} className={`h-12 border-b border-r border-gray-100 p-1 cursor-pointer transition-colors relative
          ${isSelected ? 'bg-blue-50' : 'bg-white'} hover:bg-gray-50`}>
          <span className={`text-[10px] font-medium w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-red-500 text-white' : 'text-gray-700'}`}>{d}</span>
          <div className="flex gap-0.5 mt-0.5 overflow-hidden">
            {dayLogs.slice(0, 3).map((log, i) => {
              const item = items.find(it => it.id === log.itemId);
              if (!item) return null;
              return <img key={i} src={item.imageUrl} alt="" className="w-3.5 h-3.5 object-cover rounded shadow-sm" />;
            })}
            {dayLogs.length > 3 && <span className="text-[8px] text-gray-400">+{dayLogs.length - 3}</span>}
          </div>
        </div>
      );
    }
    return days;
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 p-3 flex justify-between items-center">
        <button onClick={handlePrevMonth} className="p-1.5 hover:bg-gray-100 rounded-full"><ChevronLeft size={20}/></button>
        <h2 className="font-bold text-gray-900">{year}年 {month + 1}月</h2>
        <button onClick={handleNextMonth} className="p-1.5 hover:bg-gray-100 rounded-full"><ChevronRight size={20}/></button>
      </div>
      
      <div className="bg-white">
        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
          {['日','月','火','水','木','金','土'].map(d => <div key={d} className="text-center text-[10px] font-bold text-gray-500 py-2">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 border-l border-gray-100">{renderCalendarDays()}</div>
      </div>

      {selectedDateStr && (
        <div className="p-5 bg-white flex-1 border-t border-gray-100 shadow-[0_-10px_20px_-5px_rgba(0,0,0,0.05)] z-10 animate-in slide-in-from-bottom-2 fade-in">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-gray-900 text-lg">{selectedDateStr.split('-')[1]}月{selectedDateStr.split('-')[2]}日の記録</h3>
            {!isAdding && <button onClick={() => setIsAdding(true)} className="text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors"><Plus size={16}/>追加</button>}
          </div>

          {isAdding ? (
            <div className="space-y-4 animate-in fade-in">
              <div className="flex justify-between items-center"><span className="text-xs font-bold text-gray-500">着用したアイテムを選択</span><button onClick={()=>setIsAdding(false)} className="text-xs font-bold text-gray-400 hover:text-gray-600 px-2 py-1 bg-gray-100 rounded-md">キャンセル</button></div>
              <div className="flex overflow-x-auto gap-3 pb-3 scrollbar-hide">
                {items.map(item => (
                  <div key={item.id} onClick={() => addWearLog(item)} className="shrink-0 w-16 cursor-pointer group">
                    <img src={item.imageUrl} alt="" className="w-16 h-16 object-cover rounded-xl shadow-sm mb-1.5 group-hover:ring-2 group-hover:ring-blue-500 transition-all group-active:scale-95" />
                    <p className="text-[10px] text-center truncate text-gray-600 group-hover:text-blue-600 font-medium">{item.name}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {logsByDate[selectedDateStr]?.length > 0 ? (
                logsByDate[selectedDateStr].map(log => {
                  const item = items.find(it => it.id === log.itemId);
                  if (!item) return null;
                  return (
                    <div key={log.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-xl">
                      <div className="flex items-center gap-3">
                        <img src={item.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg" />
                        <div><p className="text-sm font-semibold">{item.name}</p><p className="text-[10px] text-gray-500">{item.category}</p></div>
                      </div>
                      <button onClick={() => removeWearLog(log.id)} className="p-2 text-red-400 hover:bg-red-50 rounded-full"><Trash2 size={16}/></button>
                    </div>
                  );
                })
              ) : (
                <p className="text-center text-sm text-gray-400 py-4">着用記録がありません</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== Disposed View ====================
function DisposedView({ items, onRestore, onPermanentDelete }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-gray-400">
        <Archive size={48} className="mb-4 text-gray-300" />
        <p className="font-medium text-gray-600">廃棄されたアイテムはありません</p>
      </div>
    );
  }
  return (
    <div className="p-4 space-y-3">
      <h2 className="font-bold text-gray-800 px-1 mb-2">廃棄済みアイテム ({items.length})</h2>
      {items.map(item => (
        <div key={item.id} className="flex gap-3 bg-white p-3 rounded-2xl shadow-sm border border-gray-100">
          <img src={item.imageUrl} alt="" className="w-20 h-20 object-cover rounded-xl opacity-60 grayscale" />
          <div className="flex-1 flex flex-col justify-center">
            <h3 className="font-semibold text-gray-900 text-sm">{item.name}</h3>
            <p className="text-xs text-gray-500 mb-2">廃棄日: {new Date(item.disposedAt).toLocaleDateString()}</p>
            <div className="flex gap-2 mt-1">
              <button onClick={() => onRestore(item)} className="text-xs font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-2 rounded-lg flex items-center gap-1 transition-colors"><RotateCcw size={14}/> 戻す</button>
              <button onClick={() => { if(window.confirm('このデータを完全に削除しますか？この操作は取り消せません。')) onPermanentDelete(item.id); }} className="text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 px-3 py-2 rounded-lg flex items-center gap-1 transition-colors"><Trash2 size={14}/> 完全削除</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== Coord View ====================
function CoordView({ items, coords, setCoords, showToast, apiKey }) {
  const [isCreating, setIsCreating] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const handleToggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleSaveCoord = async () => {
    if (selectedIds.length < 2) {
      showToast('2つ以上のアイテムを選択してください', 'error');
      return;
    }
    const newCoord = {
      id: crypto.randomUUID(),
      itemIds: selectedIds,
      rating: 0,
      createdAt: Date.now()
    };
    await saveCoord(newCoord);
    setCoords([newCoord, ...coords]);
    setIsCreating(false);
    setSelectedIds([]);
    showToast('コーディネートを保存しました', 'success');
  };

  const handleDelete = async (id) => {
    if(!window.confirm('このコーデを削除しますか？')) return;
    await deleteCoord(id);
    setCoords(coords.filter(c => c.id !== id));
    showToast('削除しました', 'success');
  };

  const handleRate = async (coord, rating) => {
    const updated = { ...coord, rating };
    await saveCoord(updated);
    setCoords(coords.map(c => c.id === coord.id ? updated : c));
  };

  if (isAiMode) {
    return <AiStylistView items={items} coords={coords} setCoords={setCoords} showToast={showToast} apiKey={apiKey} onClose={() => setIsAiMode(false)} />;
  }

  if (isCreating) {
    return (
      <div className="p-4 flex flex-col h-full animate-in fade-in">
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-gray-900">アイテムを選択 ({selectedIds.length})</h2>
          <div className="flex gap-2">
            <button onClick={() => {setIsCreating(false); setSelectedIds([]);}} className="px-4 py-2 text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">キャンセル</button>
            <button onClick={handleSaveCoord} className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-xl transition-all">保存</button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 overflow-y-auto pb-20">
          {items.map(item => {
            const isSelected = selectedIds.includes(item.id);
            return (
              <div key={item.id} onClick={() => handleToggleSelect(item.id)} className={`relative aspect-square rounded-xl overflow-hidden border-2 cursor-pointer transition-all ${isSelected ? 'border-blue-500 shadow-md scale-95' : 'border-transparent'}`}>
                <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                {isSelected && <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center"><CheckCircle2 className="text-white drop-shadow-md" size={32} /></div>}
              </div>
            )
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-bold text-gray-900">マイコーデ ({coords.length})</h2>
        <div className="flex gap-2">
          <button onClick={() => {
            if (!apiKey) { showToast('設定からAPIキーを登録してください', 'error'); return; }
            setIsAiMode(true);
          }} className="text-sm font-bold text-white bg-blue-600 px-3 py-1.5 rounded-lg flex items-center gap-1"><Sparkles size={16}/>AI提案</button>
          <button onClick={() => setIsCreating(true)} className="text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg flex items-center gap-1"><Plus size={16}/>新規作成</button>
        </div>
      </div>
      
      {coords.length === 0 ? (
        <div className="text-center py-16">
          <Layers size={48} className="mx-auto text-gray-300 mb-4" />
          <p className="text-gray-500 text-sm">保存されたコーディネートはありません</p>
        </div>
      ) : (
        <div className="space-y-4 pb-4">
          {coords.map(coord => {
            const coordItems = coord.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean);
            if(coordItems.length === 0) return null;
            return (
              <div key={coord.id} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
                {coord.reason && <p className="text-xs text-gray-500 mb-2 italic">AI: {coord.reason}</p>}
                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                  {coordItems.map(item => (
                    <img key={item.id} src={item.imageUrl} alt="" className="w-20 h-20 object-cover rounded-xl shrink-0 border border-gray-100" />
                  ))}
                </div>
                <div className="flex justify-between items-center mt-2 border-t border-gray-50 pt-3">
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map(star => (
                      <Star key={star} onClick={() => handleRate(coord, star)} size={20} className={`cursor-pointer transition-colors ${coord.rating >= star ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200'}`} />
                    ))}
                  </div>
                  <button onClick={() => handleDelete(coord.id)} className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={18}/></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== AI Stylist View ====================
function AiStylistView({ items, coords, setCoords, showToast, apiKey, onClose }) {
  const [requestText, setRequestText] = useState('');
  const [baseItemId, setBaseItemId] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleGenerate = async () => {
    if (!baseItemId) {
      showToast('基準にするアイテムを選んでください', 'error');
      return;
    }
    const baseItem = items.find(i => i.id === baseItemId);
    setIsLoading(true);
    try {
      const results = await askGeminiStylist(baseItem, requestText, items, apiKey);
      const validResults = results.map(s => ({
        ...s,
        itemIds: s.itemIds.filter(id => items.some(i => i.id === id))
      })).filter(s => s.itemIds.length >= 2);
      
      if (validResults.length === 0) {
        showToast('条件に合う提案が見つかりませんでした。', 'error');
      } else {
        setSuggestions(validResults);
      }
    } catch (error) {
      showToast(error.message || 'AIの提案に失敗しました', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveSuggestion = async (suggestion) => {
    const newCoord = {
      id: crypto.randomUUID(),
      itemIds: suggestion.itemIds,
      rating: 0,
      reason: suggestion.reason,
      createdAt: Date.now()
    };
    await saveCoord(newCoord);
    setCoords(prev => [newCoord, ...prev]);
    showToast('コーディネートを保存しました', 'success');
    setSuggestions(prev => prev.filter(s => s !== suggestion));
  };

  return (
    <div className="p-4 flex flex-col h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-bold text-gray-900">AIスタイリスト</h2>
        <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold text-gray-500 bg-gray-100 rounded-lg">キャンセル</button>
      </div>
      
      <div className="space-y-6 flex-1 overflow-y-auto pb-10">
        <div>
          <label className="text-xs font-bold text-gray-500">1. 要望 (任意)</label>
          <input 
            type="text" 
            value={requestText} 
            onChange={e => setRequestText(e.target.value)} 
            placeholder="例: デート用、少し寒めの日" 
            className="w-full mt-1.5 p-3 bg-white border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none" 
          />
        </div>
        
        <div>
           <label className="text-xs font-bold text-gray-500">2. 基準アイテム (1つ選択)</label>
           <div className="flex overflow-x-auto gap-2 mt-1.5 pb-2 scrollbar-hide">
              {items.map(item => (
                <div key={item.id} onClick={() => setBaseItemId(item.id)} className={`shrink-0 w-20 relative rounded-xl overflow-hidden border-2 cursor-pointer transition-all ${baseItemId === item.id ? 'border-blue-500 scale-95 shadow-md' : 'border-transparent'}`}>
                  <img src={item.imageUrl} alt="" className="w-full aspect-square object-cover bg-gray-100" />
                  {baseItemId === item.id && <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center"><CheckCircle2 className="text-white drop-shadow-md" size={24} /></div>}
                </div>
              ))}
           </div>
        </div>

        <button onClick={handleGenerate} disabled={isLoading || !baseItemId} className="w-full py-3.5 bg-blue-600 text-white rounded-xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 hover:bg-blue-700 transition-colors shadow-sm">
          {isLoading ? <Loader2 className="animate-spin" size={20} /> : <Sparkles size={20} />}
          {isLoading ? '提案を作成中...' : 'コーデを提案してもらう'}
        </button>

        {suggestions.length > 0 && (
          <div className="mt-6 space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <h3 className="font-bold text-gray-800">提案結果</h3>
            {suggestions.map((s, idx) => (
              <div key={idx} className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm space-y-3">
                <p className="text-sm text-gray-700 font-medium leading-relaxed">{s.reason}</p>
                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                  {s.itemIds.map(id => {
                    const item = items.find(i => i.id === id);
                    if (!item) return null;
                    return <img key={id} src={item.imageUrl} alt="" className="w-16 h-16 object-cover rounded-xl border border-gray-100 shrink-0" />
                  })}
                </div>
                <button onClick={() => handleSaveSuggestion(s)} className="w-full py-2.5 bg-gray-900 text-white text-sm font-bold rounded-xl hover:bg-gray-800 transition-colors">
                  保存する
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== Stats View (Dashboard) ====================
function StatsView({ items, wearLogs }) {
  const totalItems = items.length;
  const totalPrice = items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);

  // 着用回数集計
  const wearCounts = wearLogs.reduce((acc, log) => {
    acc[log.itemId] = (acc[log.itemId] || 0) + 1;
    return acc;
  }, {});

  const wearRanking = Object.entries(wearCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ item: items.find(i => i.id === id), count }))
    .filter(x => x.item);

  // カテゴリ集計
  const catCounts = items.reduce((acc, item) => {
    const cat = item.category || '未分類';
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});
  const catRanking = Object.entries(catCounts).sort((a,b) => b[1] - a[1]);

  return (
    <div className="p-4 space-y-4">
      <h2 className="font-bold text-gray-900 mb-2">ダッシュボード</h2>
      
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">総アイテム数</p>
          <p className="text-2xl font-bold text-gray-900">{totalItems}<span className="text-sm font-normal text-gray-500 ml-1">点</span></p>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">推定総額</p>
          <p className="text-xl font-bold text-gray-900">¥{totalPrice.toLocaleString()}</p>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-1.5"><BarChart3 size={16} className="text-blue-500"/> 着用回数 トップ5</h3>
        {wearRanking.length === 0 ? <p className="text-xs text-gray-400">記録がありません</p> : (
          <div className="space-y-3">
            {wearRanking.map((rank, i) => (
              <div key={rank.item.id} className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-400 w-3">{i+1}</span>
                <img src={rank.item.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{rank.item.name}</p>
                  <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min((rank.count / wearRanking[0].count) * 100, 100)}%` }}></div>
                  </div>
                </div>
                <span className="text-xs font-bold text-blue-600">{rank.count}回</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
        <h3 className="text-sm font-bold text-gray-800 mb-3">カテゴリ別割合</h3>
        <div className="space-y-2">
          {catRanking.map(([cat, count]) => (
            <div key={cat} className="flex items-center justify-between text-sm">
              <span className="text-gray-600">{cat}</span>
              <div className="flex items-center gap-2">
                <div className="w-24 bg-gray-100 rounded-full h-1.5">
                  <div className="bg-gray-400 h-1.5 rounded-full" style={{ width: `${(count / totalItems) * 100}%` }}></div>
                </div>
                <span className="text-gray-900 font-medium w-6 text-right">{count}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==================== Add View (Camera/AI) ====================
function AddView({ apiKey, showToast, onSuccess }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [step, setStep] = useState(1);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (selected) { setFile(selected); setPreview(URL.createObjectURL(selected)); }
  };

  const processImage = async () => {
    if (!file) return;
    setIsProcessing(true); setStep(2);
    try {
      const compressedBase64 = await compressImage(file);
      const metadata = await analyzeImageWithGemini(compressedBase64, apiKey);
      const newItem = { id: crypto.randomUUID(), imageUrl: compressedBase64, createdAt: Date.now(), disposedAt: null, ...metadata };
      await saveItem(newItem);
      onSuccess(newItem);
    } catch (err) {
      showToast(err.message || '処理中にエラーが発生しました', 'error');
      setStep(1);
    } finally { setIsProcessing(false); }
  };

  return (
    <div className="p-6">
      {step === 1 && (
        <div className="space-y-6">
          {!preview ? (
            <div className="grid grid-cols-2 gap-4">
              <button onClick={() => cameraInputRef.current?.click()} className="flex flex-col items-center justify-center p-8 bg-white rounded-3xl border border-gray-200 shadow-sm hover:border-blue-400">
                <Camera size={36} className="text-gray-400 mb-3" />
                <span className="font-medium text-sm text-gray-700">カメラ</span>
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center p-8 bg-white rounded-3xl border border-gray-200 shadow-sm hover:border-blue-400">
                <ImagePlus size={36} className="text-gray-400 mb-3" />
                <span className="font-medium text-sm text-gray-700">写真を選択</span>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="relative rounded-3xl overflow-hidden bg-gray-100 aspect-square w-full shadow-inner"><img src={preview} alt="" className="w-full h-full object-contain" /><button onClick={() => { setFile(null); setPreview(null); }} className="absolute top-4 right-4 bg-black/50 hover:bg-black/70 active:scale-95 text-white p-2 rounded-full transition-all" aria-label="画像を削除"><X size={20} /></button></div>
              <button onClick={processImage} disabled={isProcessing} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold text-lg shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"><Sparkles size={20} /> AIで解析して保存</button>
            </div>
          )}
          <input type="file" ref={cameraInputRef} accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleFileChange} />
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col items-center justify-center py-24"><div className="relative w-20 h-20 mb-6"><div className="absolute inset-0 border-4 border-gray-100 rounded-full"></div><div className="absolute inset-0 border-4 border-blue-600 rounded-full border-t-transparent animate-spin"></div><div className="absolute inset-0 flex items-center justify-center text-blue-600"><Sparkles size={28} className="animate-pulse" /></div></div><h3 className="text-lg font-bold text-gray-900 mb-2">AIが解析中...</h3></div>
      )}
    </div>
  );
}

// ==================== Settings View ====================
function SettingsView({ apiKey, setApiKey, showToast, onDataImported, onOpenDisposed }) {
  const [localKey, setLocalKey] = useState(apiKey);
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef(null);

  const handleSaveKey = () => { localStorage.setItem('giga_closet_api_key', localKey); setApiKey(localKey); showToast('保存しました', 'success'); };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const items = await getAllItems();
      const wearLogs = await getAllWearLogs();
      const coords = await getAllCoords();
      
      const backupData = { items, wearLogs, coords };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `giga_closet_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('バックアップをダウンロードしました', 'success');
    } catch (err) {
      showToast('エクスポートに失敗しました', 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (e) => {
    // スマホで複数選択されたファイルをすべて配列として取得する
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (!window.confirm(`選択された ${files.length} 個のファイルからデータをインポートします。よろしいですか？\n※データ量が多い場合、少し時間がかかります。`)) return;

    showToast('データをインポート中...', 'info');

    try {
      let importedItemsCount = 0;

      // 選択された全ファイルを順番に処理する
      for (const file of files) {
        const text = await file.text();
        const backupData = JSON.parse(text);
        
        // 旧バージョンのバックアップ（配列のみ）の互換性対応
        const items = Array.isArray(backupData) ? backupData : (backupData.items || []);
        const wearLogs = backupData.wearLogs || [];
        const coords = backupData.coords || [];

        for (const item of items) {
          if (item.id && item.imageUrl) await saveItem(item);
        }
        for (const log of wearLogs) {
          if (log.id && log.itemId) await saveWearLog(log);
        }
        for (const coord of coords) {
          if (coord.id && coord.itemIds) await saveCoord(coord);
        }
        
        importedItemsCount += items.length;
      }
      
      showToast(`復元が完了しました（アイテム計: ${importedItemsCount}件）`, 'success');
      onDataImported(); // データを再読み込み
    } catch (err) {
      console.error(err);
      showToast('一部のインポートに失敗しました。正しいJSONか確認してください', 'error');
    }
    e.target.value = '';
  };

  return (
    <div className="p-6 space-y-6">
      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <h3 className="font-bold mb-2 flex items-center gap-2 text-gray-800"><Settings size={18}/> Gemini APIキー</h3>
        <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="AIzaSy..." className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl mb-3 text-sm font-mono" />
        <button onClick={handleSaveKey} className="w-full py-3 bg-gray-900 text-white rounded-xl font-bold text-sm">保存する</button>
      </section>

      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
         <h3 className="font-bold mb-3 flex items-center gap-2 text-gray-800"><Archive size={18}/> アーカイブ</h3>
         <button onClick={onOpenDisposed} className="w-full py-3 bg-gray-50 hover:bg-gray-100 text-gray-700 rounded-xl font-bold text-sm border border-gray-200 transition-colors flex justify-between items-center px-4">
           廃棄済みアイテムを確認
           <ChevronRight size={16} className="text-gray-400" />
         </button>
      </section>

      <section className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
        <h3 className="font-bold mb-2 text-gray-800">データ管理</h3>
        <p className="text-xs text-gray-500 mb-6 leading-relaxed">
          クローゼットの全データ（画像、着用記録、コーデ）はブラウザ内に保存されています。バックアップと復元を行えます。
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button 
            onClick={handleExport}
            disabled={isExporting}
            className="flex flex-col items-center justify-center py-4 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl transition-colors border border-blue-100 disabled:opacity-50"
          >
            <Download size={24} className="mb-1" />
            <span className="font-bold text-sm">エクスポート</span>
          </button>
          
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center py-4 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-xl transition-colors border border-emerald-100"
          >
            <Upload size={24} className="mb-1" />
            <span className="font-bold text-sm">インポート</span>
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            multiple /* 複数選択を許可 */
            accept="application/json,.json,text/plain,*/*" /* スマホでグレーアウトして押せなくなる現象を回避 */
            className="hidden" 
            onChange={handleImport} 
          />
        </div>
      </section>
    </div>
  );
}

// ==================== AIChat View ====================
function AIChatView({ items, coords, apiKey, showToast }) {
  const [messages, setMessages] = useState([{ role: 'model', text: 'こんにちは！あなたの専属スタイリストです。手持ちのアイテムを使ったコーデの提案や、買い足すべきアイテムのアドバイスなど、何でも聞いてください。画像を添付して相談することもできますよ！' }]);
  const [input, setInput] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const compressedBase64 = await compressImage(file, 800, 0.7);
        setSelectedImage(compressedBase64);
      } catch (err) {
        showToast('画像の処理に失敗しました', 'error');
      }
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
    
    const textToSend = input.trim() || 'この画像についてどう思いますか？';
    const userMsg = { role: 'user', text: textToSend, image: selectedImage };
    
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSelectedImage(null);
    setIsLoading(true);

    const textarea = document.getElementById('chat-textarea');
    if (textarea) textarea.style.height = '44px';

    try {
      const apiHistory = messages.filter((_, i) => i !== 0); 
      const reply = await askGeminiChat(textToSend, userMsg.image, apiHistory, items, coords, apiKey);
      setMessages(prev => [...prev, { role: 'model', text: reply }]);
    } catch (err) {
      showToast(err.message || 'AIの応答に失敗しました', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 pb-safe">
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-3.5 rounded-2xl ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white border border-gray-100 shadow-sm rounded-tl-none text-gray-800'}`}>
              {msg.image && (
                <img src={msg.image} alt="attached" className="max-w-full h-auto rounded-lg mb-2 object-contain max-h-48 border border-white/20" />
              )}
              {msg.text && <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{msg.text}</p>}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-100 shadow-sm p-3.5 rounded-2xl rounded-tl-none">
              <Loader2 className="animate-spin text-blue-500" size={18} />
            </div>
          </div>
        )}
      </div>
      
      <div className="bg-white border-t border-gray-100 shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.02)] flex flex-col">
        {selectedImage && (
          <div className="px-4 pt-3 relative inline-block self-start">
            <div className="relative">
              <img src={selectedImage} alt="preview" className="h-16 w-16 object-cover rounded-xl border border-gray-200" />
              <button 
                onClick={() => setSelectedImage(null)}
                className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full p-1 shadow-sm hover:bg-gray-700 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}
        <div className="p-3 flex gap-2 items-end">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 rounded-xl transition-colors shrink-0 mb-0.5"
            aria-label="画像を添付"
          >
            <ImagePlus size={22} />
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            accept="image/*" 
            className="hidden" 
            onChange={handleFileSelect}
          />
          <textarea 
            id="chat-textarea"
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="AIに相談する..."
            className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow resize-none overflow-y-auto"
            rows="1"
            style={{ minHeight: '44px', height: '44px' }}
          />
          <button 
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && !selectedImage)}
            className="p-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-all shrink-0 mb-0.5"
            aria-label="送信"
          >
            <Sparkles size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
