import React, { useState, useEffect, useMemo } from 'react';
import { 
  ClipboardList, Trophy, Save, Calendar, 
  ChevronLeft, ChevronRight, Trash2, BarChart3, 
  AlertTriangle, Lock, CheckCircle2,
  Trees, Home, Brush
} from 'lucide-react';

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, onSnapshot, 
  serverTimestamp, writeBatch, getDocs
} from 'firebase/firestore';
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from 'firebase/auth';


// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDwdwx7-hcD9OFo_vfRVoI7ZZwyy-QHrvI",
  authDomain: "school-orderliness.firebaseapp.com",
  projectId: "school-orderliness",
  storageBucket: "school-orderliness.firebasestorage.app",
  messagingSenderId: "479350417864",
  appId: "1:479350417864:web:d44c8030b4900b195378fd"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = "school-app"; // 這裡隨便給一個名字即可


// 設定新的 Collection 名稱
const COLLECTION_NAME = "school_cleanliness_scores_v1";

// --- Constants & Data ---
const GRADES = [1, 2, 3];

// 班級數量設定
const CLASS_COUNTS = {
  1: 4, // 一年級 101-104
  2: 5, // 二年級 201-205
  3: 5  // 三年級 301-305
};

const generateClasses = (grade) => 
  Array.from({ length: CLASS_COUNTS[grade] || 0 }, (_, i) => `${grade}${String(i + 1).padStart(2, '0')}`);

// 評分項目類型
const SCORE_TYPES = [
  { id: 'classroom', label: '教室整潔', icon: Home, color: 'text-blue-600', bg: 'bg-blue-100', border: 'border-blue-200' },
  { id: 'exterior', label: '外掃區域', icon: Trees, color: 'text-emerald-600', bg: 'bg-emerald-100', border: 'border-emerald-200' }
];

// Helper: Get Week Number
const getWeekNumber = (d) => {
  if (!d || isNaN(d.getTime())) return "Invalid-Date";
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const App = () => {
  // --- State ---
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState('score');
  const [scoresData, setScoresData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // UI Components State
  const [modalConfig, setModalConfig] = useState({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminModal, setShowAdminModal] = useState(false);

  // Scoring Form State
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedType, setSelectedType] = useState('classroom'); // 'classroom' or 'exterior'
  const [selectedGrade, setSelectedGrade] = useState(1);
  const [currentScores, setCurrentScores] = useState({}); 

  // Ranking View State
  const [viewWeek, setViewWeek] = useState(getWeekNumber(new Date()));

  // --- Auth & Sync ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error("Auth Error:", e);
        showToast(`登入失敗: ${e.message}`, 'error');
      }
    };
    initAuth();
    
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;
    
    const q = collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME);
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setScoresData(data);
      setLoading(false);
    }, (error) => {
      console.error("Snapshot Error:", error);
      showToast("無法讀取資料", 'error');
      setLoading(false);
    });
    return () => unsubscribe();
  }, [authReady, user]);

  // 關鍵修正：當切換評分類別、日期或年級時，清空目前選擇的分數，避免混淆
  // 修改：移除 selectedGrade，這樣切換年級時分數會保留
  useEffect(() => {
    setCurrentScores({});
  }, [selectedType, selectedDate]); 

  // --- Helper UI Functions ---
  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
  };

  const closeModal = () => {
    setModalConfig({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
    setAdminPassword('');
  };

  // --- Calculations ---
  
  // 計算本週的詳細分數 (分開計算教室和外掃)
  const currentWeekStats = useMemo(() => {
    const todayWeek = getWeekNumber(new Date(selectedDate)); 
    const filtered = scoresData.filter(d => d.week === todayWeek);
    
    // 初始化資料結構
    const stats = {}; 
    GRADES.forEach(g => {
      generateClasses(g).forEach(c => {
        stats[c] = { classroom: 0, exterior: 0, total: 0 };
      });
    });

    filtered.forEach(record => {
      if (!stats[record.classId]) {
        stats[record.classId] = { classroom: 0, exterior: 0, total: 0 };
      }
      
      if (record.type === 'classroom') {
        stats[record.classId].classroom += record.score;
      } else if (record.type === 'exterior') {
        stats[record.classId].exterior += record.score;
      }
      // 總分累積
      stats[record.classId].total += record.score;
    });

    return stats; 
  }, [scoresData, selectedDate]);

  // 計算排行榜 (依據總分)
  const weeklyRankings = useMemo(() => {
    const filtered = scoresData.filter(d => d.week === viewWeek);
    
    const totals = {}; 
    GRADES.forEach(g => generateClasses(g).forEach(c => totals[c] = 0));

    filtered.forEach(record => {
      if (totals[record.classId] === undefined) totals[record.classId] = 0;
      totals[record.classId] += record.score;
    });

    const result = {};
    GRADES.forEach(g => {
      const gradeClasses = Object.keys(totals).filter(c => c.startsWith(String(g)));
      // 由高到低排序
      const sorted = gradeClasses.map(c => ({ classId: c, total: totals[c] }))
                                 .sort((a, b) => b.total - a.total);
      result[g] = sorted;
    });

    return result;
  }, [scoresData, viewWeek]);

  const currentWeekLabel = useMemo(() => {
     const parts = viewWeek.split('-W');
     if (parts.length !== 2) return viewWeek;
     return `${parts[0]}年 第 ${parts[1]} 週`;
  }, [viewWeek]);

  const getTypeName = (typeId) => SCORE_TYPES.find(t => t.id === typeId)?.label || typeId;

  // --- Handlers ---

  const handleScoreChange = (classId, val) => {
    setCurrentScores(prev => {
      const newScores = { ...prev };
      if (val === 0) {
        // 如果分數改回 0 (且原本資料庫沒資料)，視為取消評分，雖然這邏輯比較複雜，
        // 但為了簡單起見，我們這裡記錄 0 分，除非使用者明確想刪除。
        // 不過為了讓介面乾淨，如果真的是 0，或許可以保留 key。
        // 這裡維持原樣: 記錄 val。
      }
      return { ...prev, [classId]: val };
    });
  };

  const handleConfirmSubmit = () => {
    if (!user) return showToast("系統尚未連線", 'error');
    
    const scoreCount = Object.keys(currentScores).length;
    if (scoreCount === 0) return showToast("請至少評分一個班級", 'error');
    if (!selectedDate) return showToast("請選擇日期", 'error');

    const typeName = getTypeName(selectedType);

    setModalConfig({
      isOpen: true,
      type: 'confirm',
      title: '確認儲存',
      message: `確定要一次儲存 ${scoreCount} 筆【${typeName}】評分嗎？`, // 修改提示訊息
      onConfirm: executeSubmit
    });
  };

  const executeSubmit = async () => {
    closeModal();
    setSubmitting(true);

    try {
      const batch = writeBatch(db);
      const weekNum = getWeekNumber(new Date(selectedDate));
      const timestamp = serverTimestamp();
      const raterUid = user.uid; 
      
      let opCount = 0;

      Object.entries(currentScores).forEach(([classId, score]) => {
        const docRef = doc(collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME));
        const gradeNum = parseInt(classId.substring(0, 1), 10);
        const scoreNum = Number(score);
        
        if (!isNaN(gradeNum) && !isNaN(scoreNum)) {
          batch.set(docRef, {
            date: selectedDate,
            week: weekNum,
            type: selectedType, // 關鍵：記錄分數類型
            grade: gradeNum,
            classId: String(classId),
            score: scoreNum,
            createdAt: timestamp,
            raterUid: raterUid
          });
          opCount++;
        }
      });

      if (opCount > 0) {
        await batch.commit();
        showToast(`成功儲存 ${opCount} 筆評分！`, 'success');
        setCurrentScores({});
      } else {
        showToast("沒有有效的評分數據", 'error');
      }
    } catch (e) {
      console.error("Submit Error:", e);
      showToast(`儲存失敗: ${e.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = (recordId) => {
    setModalConfig({
      isOpen: true,
      type: 'delete',
      title: '刪除紀錄',
      message: '確定要刪除這筆評分紀錄嗎？',
      onConfirm: () => executeDelete(recordId)
    });
  };

  const executeDelete = async (recordId) => {
    closeModal();
    try {
      const batch = writeBatch(db);
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME, recordId);
      batch.delete(docRef);
      await batch.commit();
      showToast("紀錄已刪除", 'success');
    } catch (e) {
      showToast(`刪除失敗: ${e.message}`, 'error');
    }
  };

  const handleClearHistoryRequest = () => {
    setShowAdminModal(true);
  };

  const executeClearHistory = async () => {
    if (adminPassword !== "admin888") {
      showToast("密碼錯誤", 'error');
      return;
    }
    setShowAdminModal(false);
    setAdminPassword('');
    
    setModalConfig({
      isOpen: true,
      type: 'delete',
      title: '清空所有資料',
      message: '警告：這將刪除資料庫中「所有」的整潔評分資料，確定要執行嗎？',
      onConfirm: async () => {
        closeModal();
        setSubmitting(true);
        try {
          const q = collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME);
          const snapshot = await getDocs(q);
          const batch = writeBatch(db);
          snapshot.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          showToast("所有資料已清空", 'success');
        } catch (e) {
          showToast(`清空失敗: ${e.message}`, 'error');
        } finally {
          setSubmitting(false);
        }
      }
    });
  };

  const changeWeek = (delta) => {
    const [year, week] = viewWeek.split('-W').map(Number);
    if (!year || !week) return;
    let newYear = year;
    let newWeek = week + delta;
    if (newWeek > 52) { newWeek = 1; newYear++; }
    if (newWeek < 1) { newWeek = 52; newYear--; }
    setViewWeek(`${newYear}-W${String(newWeek).padStart(2, '0')}`);
  };

  // --- Sub-Components ---
  
  const ClassScoreRow = ({ classId, stats }) => {
    const score = currentScores.hasOwnProperty(classId) ? currentScores[classId] : 0;
    
    // 取得個別分數，如果不存在則為 0
    const classroomScore = stats?.classroom || 0;
    const exteriorScore = stats?.exterior || 0;
    
    const isClassroomActive = selectedType === 'classroom';
    const isExteriorActive = selectedType === 'exterior';

    return (
      <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-white p-3 rounded-lg shadow-sm border border-slate-200 gap-3">
        <div className="flex flex-row sm:flex-col items-center sm:items-start justify-between sm:justify-center w-full sm:w-32 pr-2">
          <div className="font-black text-xl text-slate-800">{classId}</div>
          
          {/* 詳細分數顯示區 */}
          <div className="flex gap-2 text-[10px] sm:text-xs mt-0 sm:mt-1">
            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${isClassroomActive ? 'bg-blue-50 border-blue-200 text-blue-700 font-bold' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
              <Home size={10} />
              <span>{classroomScore > 0 ? '+' : ''}{classroomScore}</span>
            </div>
            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${isExteriorActive ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-bold' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
              <Trees size={10} />
              <span>{exteriorScore > 0 ? '+' : ''}{exteriorScore}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center justify-center gap-1 flex-1 overflow-x-auto w-full">
           <div className={`flex items-center rounded-lg p-1 gap-1 ${selectedType === 'classroom' ? 'bg-blue-50/50' : 'bg-emerald-50/50'}`}>
             {[-3, -2, -1].map(v => (
               <button
                 key={v}
                 onClick={() => handleScoreChange(classId, v)}
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center
                   ${score === v 
                     ? 'bg-red-500 text-white shadow-md scale-110 z-10' 
                     : 'text-red-400 hover:bg-red-100 bg-white border border-slate-100'}`}
               >
                 {v}
               </button>
             ))}
             <button
               onClick={() => handleScoreChange(classId, 0)}
               className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center mx-1
                 ${score === 0 
                   ? 'bg-slate-500 text-white shadow-md scale-110 z-10' 
                   : 'text-slate-400 hover:bg-slate-200 bg-white border border-slate-100'}`}
             >
               0
             </button>
             {[1, 2, 3].map(v => (
               <button
                 key={v}
                 onClick={() => handleScoreChange(classId, v)}
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center
                   ${score === v 
                     ? (selectedType === 'classroom' ? 'bg-blue-500 text-white shadow-md scale-110' : 'bg-emerald-500 text-white shadow-md scale-110') 
                     : (selectedType === 'classroom' ? 'text-blue-500 hover:bg-blue-100 bg-white border border-slate-100' : 'text-emerald-500 hover:bg-emerald-100 bg-white border border-slate-100')}`}
               >
                 +{v}
               </button>
             ))}
           </div>
        </div>
      </div>
    );
  };

  // --- Render ---
  if (!authReady || loading) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100">
          <div className="flex flex-col items-center p-8 bg-white rounded-xl shadow-lg">
             <div className="animate-spin mb-4">
               <Brush className="text-emerald-500" size={32}/>
             </div>
            <p className="text-slate-600 font-medium">整潔系統載入中...</p>
          </div>
        </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 relative">
      
      {/* Modals & Toasts */}
      {modalConfig.isOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full overflow-hidden transform transition-all scale-100">
            <div className={`p-4 ${modalConfig.type === 'delete' ? 'bg-red-50' : 'bg-emerald-50'} border-b border-slate-100 flex items-center gap-3`}>
              {modalConfig.type === 'delete' ? <AlertTriangle className="text-red-500"/> : <CheckCircle2 className="text-emerald-500"/>}
              <h3 className="font-bold text-lg text-slate-800">{modalConfig.title}</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600 font-medium">{modalConfig.message}</p>
            </div>
            <div className="p-4 bg-slate-50 flex gap-3">
              <button onClick={closeModal} className="flex-1 py-2.5 text-slate-500 font-bold hover:bg-slate-200 rounded-lg transition-colors">取消</button>
              <button 
                onClick={modalConfig.onConfirm} 
                className={`flex-1 py-2.5 text-white font-bold rounded-lg shadow-lg transition-transform active:scale-95 ${modalConfig.type === 'delete' ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}
              >
                確定
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdminModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center gap-2">
              <Lock size={20}/>
              <h3 className="font-bold">管理員權限</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-500 mb-2">請輸入管理密碼：</p>
              <input 
                type="password" 
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none font-bold tracking-widest"
                placeholder="Password"
              />
            </div>
            <div className="p-4 bg-slate-50 flex gap-3">
              <button onClick={() => setShowAdminModal(false)} className="flex-1 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-lg">取消</button>
              <button onClick={executeClearHistory} className="flex-1 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-black">驗證</button>
            </div>
          </div>
        </div>
      )}

      <div className={`fixed bottom-24 left-1/2 transform -translate-x-1/2 z-50 transition-all duration-300 ${toast.show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10 pointer-events-none'}`}>
        <div className={`flex items-center gap-3 px-6 py-3 rounded-full shadow-2xl border ${toast.type === 'error' ? 'bg-red-600 text-white border-red-700' : 'bg-emerald-600 text-white border-emerald-700'}`}>
          {toast.type === 'error' ? <AlertTriangle size={20} className="animate-pulse"/> : <CheckCircle2 size={20}/>}
          <span className="font-bold tracking-wide">{toast.message}</span>
        </div>
      </div>

      {/* Header */}
      <header className="bg-emerald-900 text-white p-4 shadow-lg sticky top-0 z-20">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-600 rounded-lg">
              <Brush size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-wide">校園整潔評分</h1>
              <p className="text-xs text-emerald-200 flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${user ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`}></span>
                {user ? `系統連線中` : '連線中...'}
              </p>
            </div>
          </div>
          {activeTab === 'history' && (
             <button onClick={handleClearHistoryRequest} className="text-xs bg-red-900/50 text-red-200 px-3 py-1.5 rounded border border-red-800 hover:bg-red-900 flex items-center gap-1">
               <Trash2 size={12}/> 清除
             </button>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        
        {/* Main Tabs */}
        <div className="flex bg-white p-1 rounded-xl shadow-sm mb-6 border border-slate-200">
          <button 
            onClick={() => setActiveTab('score')}
            className={`flex-1 py-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all ${activeTab === 'score' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <ClipboardList size={18} /> 評分
          </button>
          <button 
            onClick={() => setActiveTab('ranking')}
            className={`flex-1 py-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all ${activeTab === 'ranking' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <Trophy size={18} /> 整潔榮譽榜
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-3 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all ${activeTab === 'history' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <BarChart3 size={18} /> 紀錄
          </button>
        </div>

        {/* SCORING TAB */}
        {activeTab === 'score' && (
          <div className="animate-fade-in">
            
            {/* Type Selector (Classroom vs Exterior) */}
            <div className="grid grid-cols-2 gap-3 mb-4">
               {SCORE_TYPES.map(type => {
                 const Icon = type.icon;
                 const isActive = selectedType === type.id;
                 return (
                   <button
                     key={type.id}
                     onClick={() => setSelectedType(type.id)}
                     className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-2
                       ${isActive ? `border-${type.color.split('-')[1]} ${type.bg} ${type.color}` : 'border-slate-100 bg-white text-slate-400 hover:bg-slate-50'}`}
                   >
                     <Icon size={24} strokeWidth={isActive ? 2.5 : 2}/>
                     <span className="font-bold">{type.label}</span>
                   </button>
                 )
               })}
            </div>

            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-4 space-y-4">
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-400 mb-1 uppercase">日期</label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-2.5 text-slate-400" size={16}/>
                    <input 
                      type="date" 
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm font-bold"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-400 mb-2 uppercase">選擇年級</label>
                <div className="flex gap-2">
                  {GRADES.map(g => {
                    // 檢查該年級是否有尚未儲存的分數
                    const hasUnsaved = Object.keys(currentScores).some(classId => classId.startsWith(String(g)));
                    
                    return (
                      <button
                        key={g}
                        onClick={() => setSelectedGrade(g)}
                        className={`flex-1 py-2 rounded-lg font-bold text-sm transition-all relative ${selectedGrade === g ? 'bg-slate-800 text-white shadow-md ring-2 ring-offset-2 ring-slate-800' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                      >
                        {g} 年級
                        {hasUnsaved && (
                          <span className="absolute -top-1 -right-1 flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-3 mb-20">
              {generateClasses(selectedGrade).map(classId => (
                <ClassScoreRow 
                  key={classId} 
                  classId={classId} 
                  stats={currentWeekStats[classId] || {}} 
                />
              ))}
            </div>

            <div className="fixed bottom-6 left-0 right-0 px-4 z-30 max-w-3xl mx-auto">
              <button 
                onClick={handleConfirmSubmit}
                disabled={submitting}
                className={`w-full text-white py-4 rounded-xl shadow-xl font-bold text-lg flex items-center justify-center gap-2 active:scale-95 transition-transform disabled:opacity-70 disabled:scale-100
                  ${selectedType === 'classroom' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
              >
                {submitting ? (
                   <span>儲存中...</span>
                ) : (
                   <>
                     <Save size={20} /> 
                     {Object.keys(currentScores).length > 0 
                       ? `儲存 ${Object.keys(currentScores).length} 筆評分` 
                       : `儲存【${getTypeName(selectedType)}】評分`}
                   </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* RANKING TAB */}
        {activeTab === 'ranking' && (
          <div className="animate-fade-in space-y-6">
            <div className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border border-slate-200">
              <button onClick={() => changeWeek(-1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronLeft size={20}/></button>
              <div className="text-center">
                <div className="text-xs text-slate-400 font-bold uppercase tracking-wider">目前檢視</div>
                <div className="text-xl font-black text-emerald-900">{currentWeekLabel}</div>
                <div className="text-[10px] text-emerald-600 font-bold">(教室 + 外掃 總積分)</div>
              </div>
              <button onClick={() => changeWeek(1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronRight size={20}/></button>
            </div>

            {GRADES.map(grade => {
              const data = weeklyRankings[grade] || [];
              const top1 = data[0];
              const top2 = data[1];

              return (
                <div key={grade} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="bg-slate-50 p-3 border-b border-slate-100 flex justify-between items-center">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2">
                      <span className="bg-emerald-600 text-white text-xs px-2 py-0.5 rounded">{grade} 年級</span>
                      總排行榜
                    </h3>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 p-4 bg-gradient-to-b from-white to-slate-50">
                    {/* Winner */}
                    <div className="flex flex-col items-center relative mt-4">
                      <Trophy className="text-yellow-400 drop-shadow-sm absolute -top-6" size={32} fill="currentColor"/>
                      <div className="w-full bg-yellow-50 border-2 border-yellow-200 rounded-xl p-4 text-center shadow-sm relative z-10">
                        <div className="text-xs font-bold text-yellow-600 uppercase mb-1">第一名</div>
                        <div className="text-3xl font-black text-slate-800 mb-1">{top1 ? top1.classId : '-'}</div>
                        <div className="text-sm font-bold text-slate-500 bg-white/50 rounded-lg py-1">
                          {top1 ? `${top1.total > 0 ? '+' : ''}${top1.total}` : '--'} 分
                        </div>
                      </div>
                    </div>

                    {/* Runner Up */}
                    <div className="flex flex-col items-center relative mt-8">
                       <div className="absolute -top-5 bg-slate-200 text-slate-500 text-xs font-bold px-2 py-0.5 rounded-full border border-slate-300 z-20">第二名</div>
                       <div className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl p-4 text-center shadow-sm relative z-10">
                        <div className="text-2xl font-bold text-slate-700 mb-1 opacity-80">{top2 ? top2.classId : '-'}</div>
                         <div className="text-sm font-bold text-slate-400">
                          {top2 ? `${top2.total > 0 ? '+' : ''}${top2.total}` : '--'} 分
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-slate-100">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-400 text-xs uppercase">
                         <tr>
                           <th className="p-2 text-left pl-4">排名</th>
                           <th className="p-2 text-left">班級</th>
                           <th className="p-2 text-right pr-4">總分</th>
                         </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {data.slice(2, 5).map((item, idx) => (
                          <tr key={item.classId}>
                            <td className="p-2 pl-4 font-bold text-slate-400">#{idx + 3}</td>
                            <td className="p-2 font-medium text-slate-600">{item.classId}</td>
                            <td className={`p-2 pr-4 text-right font-bold ${item.total >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                              {item.total > 0 ? '+' : ''}{item.total}
                            </td>
                          </tr>
                        ))}
                        {data.length > 5 && (
                          <tr><td colSpan="3" className="text-center p-2 text-xs text-slate-400 italic">僅顯示前 5 名</td></tr>
                        )}
                         {data.length === 0 && (
                          <tr><td colSpan="3" className="text-center p-6 text-slate-400">尚無資料</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
               <div className="p-4 border-b border-slate-100 flex justify-between items-center">
                  <h3 className="font-bold text-slate-800">評分流水帳</h3>
                  <span className="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded">{scoresData.length} 筆</span>
               </div>
               <div className="max-h-[60vh] overflow-y-auto">
                 <table className="w-full text-sm">
                   <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                     <tr>
                       <th className="p-3 text-left">班級/日期</th>
                       <th className="p-3 text-left">類別</th>
                       <th className="p-3 text-right">分數</th>
                       <th className="p-3 w-10"></th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {scoresData.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).map(record => (
                       <tr key={record.id} className="hover:bg-slate-50 group">
                         <td className="p-3">
                           <div className="font-bold text-slate-700">{record.classId}</div>
                           <div className="text-xs text-slate-400">{record.date}</div>
                         </td>
                         <td className="p-3">
                           <span className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 w-fit
                             ${record.type === 'classroom' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
                             {record.type === 'classroom' ? <Home size={10}/> : <Trees size={10}/>}
                             {getTypeName(record.type)}
                           </span>
                         </td>
                         <td className="p-3 text-right">
                           <span className={`font-bold ${record.score > 0 ? 'text-emerald-600' : (record.score < 0 ? 'text-red-600' : 'text-slate-400')}`}>
                             {record.score > 0 ? '+' : ''}{record.score}
                           </span>
                         </td>
                         <td className="p-3 text-center">
                            <button 
                              onClick={() => handleConfirmDelete(record.id)}
                              className="text-slate-300 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={16} />
                            </button>
                         </td>
                       </tr>
                     ))}
                     {scoresData.length === 0 && (
                        <tr><td colSpan="4" className="p-8 text-center text-slate-400">無歷史資料</td></tr>
                     )}
                   </tbody>
                 </table>
               </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;