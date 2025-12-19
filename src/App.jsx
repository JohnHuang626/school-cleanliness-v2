import React, { useState, useEffect, useMemo } from 'react';
import { 
  ClipboardList, Trophy, Save, Calendar, 
  ChevronLeft, ChevronRight, Trash2, BarChart3, 
  AlertTriangle, Lock, CheckCircle2,
  Trees, Home, Brush, AlertOctagon, Settings, KeyRound, MessageSquare
} from 'lucide-react';

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, onSnapshot, getDoc, setDoc,
  serverTimestamp, writeBatch, query, orderBy, limit, where 
} from 'firebase/firestore';
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from 'firebase/auth';

// --- Configuration ---
let firebaseConfig;
let appId;

if (typeof __firebase_config !== 'undefined') {
  // Canvas 預覽環境
  firebaseConfig = JSON.parse(__firebase_config);
  appId = typeof __app_id !== 'undefined' ? __app_id : "school-app";
} else {
  // Vercel / 本地開發環境
  firebaseConfig = {
    apiKey: "AIzaSyDwdwx7-hcD9OFo_vfRVoI7ZZwyy-QHrvI", 
    authDomain: "school-orderliness.firebaseapp.com",
    projectId: "school-orderliness",
    storageBucket: "school-orderliness.firebasestorage.app",
    messagingSenderId: "479350417864",
    appId: "1:479350417864:web:d44c8030b4900b195378fd"
  };
  appId = "school-app";
}

// 防止重複初始化
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 設定 Collection 名稱
const COLLECTION_NAME = "school_cleanliness_scores_v1";
const SETTINGS_COLLECTION = "school_settings_v1"; // 新增設定的 Collection

// --- Constants ---
const GRADES = [1, 2, 3];
// 預設值 (如果資料庫沒設定時使用)
const DEFAULT_CLASS_COUNTS = { 1: 4, 2: 5, 3: 5 };

// Helper: Generate Classes (現在改為接收 counts 參數)
const getClassesList = (grade, counts) => 
  Array.from({ length: counts[grade] || 0 }, (_, i) => `${grade}${String(i + 1).padStart(2, '0')}`);

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

  // Settings & Admin State
  const [classCounts, setClassCounts] = useState(DEFAULT_CLASS_COUNTS);
  const [tempClassCounts, setTempClassCounts] = useState(DEFAULT_CLASS_COUNTS); // 用於設定頁面的暫存
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');

  // UI State
  const [modalConfig, setModalConfig] = useState({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  
  // Scoring Form State
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedType, setSelectedType] = useState('classroom');
  const [selectedGrade, setSelectedGrade] = useState(1);
  const [currentScores, setCurrentScores] = useState({}); 
  const [remarks, setRemarks] = useState(''); // 新增：反映事項

  // Ranking View State
  const [viewWeek, setViewWeek] = useState(getWeekNumber(new Date()));

  // --- Auth ---
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

  // --- Data Sync ---
  // 1. Load Settings
  useEffect(() => {
    if (!authReady || !user) return;

    const fetchSettings = async () => {
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', SETTINGS_COLLECTION, 'config');
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.classCounts) {
            setClassCounts(data.classCounts);
            setTempClassCounts(data.classCounts);
          }
        }
      } catch (e) {
        console.error("Error fetching settings:", e);
        // 如果讀取失敗，保持預設值
      }
    };
    fetchSettings();
  }, [authReady, user]);

  // 2. Load Scores
  useEffect(() => {
    if (!authReady || !user) return;
    
    try {
        const q = query(
          collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME),
          orderBy('createdAt', 'desc'),
          limit(300)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
          const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          setScoresData(data);
          setLoading(false);
        }, (error) => {
          console.error("Snapshot Error:", error);
          if (error.code !== 'permission-denied' && error.code !== 'failed-precondition') {
             showToast("無法讀取資料", 'error');
          }
          setLoading(false);
        });
        return () => unsubscribe();
    } catch (err) {
        console.error("Query Error", err);
        setLoading(false);
    }
  }, [authReady, user]);

  // 切換類別或日期時，清空暫存分數與反映事項
  useEffect(() => {
    setCurrentScores({});
    setRemarks('');
  }, [selectedType, selectedDate]); 

  // --- Helper UI Functions ---
  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
  };

  const closeModal = () => {
    setModalConfig({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  };

  // --- Calculations ---
  const currentWeekStats = useMemo(() => {
    const targetWeek = getWeekNumber(new Date(selectedDate)); 
    const filtered = scoresData.filter(d => d.week === targetWeek);
    
    const stats = {}; 
    GRADES.forEach(g => {
      // 使用動態的 classCounts
      getClassesList(g, classCounts).forEach(c => {
        stats[c] = { classroom: 0, exterior: 0, total: 0 };
      });
    });

    filtered.forEach(record => {
      if (!stats[record.classId]) {
        // 如果歷史資料中有班級，但現在設定中已移除該班級，這裡會忽略它
        // 若希望顯示歷史資料，可以改為自動補上 key
        return;
      }
      if (record.type === 'classroom') stats[record.classId].classroom += record.score;
      else if (record.type === 'exterior') stats[record.classId].exterior += record.score;
      stats[record.classId].total += record.score;
    });

    return stats; 
  }, [scoresData, selectedDate, classCounts]);

  const weeklyRankings = useMemo(() => {
    const filtered = scoresData.filter(d => d.week === viewWeek);
    const totals = {}; 
    
    // 使用動態的 classCounts
    GRADES.forEach(g => getClassesList(g, classCounts).forEach(c => totals[c] = 0));

    filtered.forEach(record => {
      // 確保只計算目前設定中存在的班級
      if (totals[record.classId] !== undefined) {
        totals[record.classId] += record.score;
      }
    });

    const result = {};
    GRADES.forEach(g => {
      const gradeClasses = Object.keys(totals).filter(c => c.startsWith(String(g)));
      const sorted = gradeClasses
        .map(c => ({ classId: c, total: totals[c] }))
        .sort((a, b) => b.total - a.total);
      result[g] = sorted;
    });

    return result;
  }, [scoresData, viewWeek, classCounts]);

  const currentWeekLabel = useMemo(() => {
      const parts = viewWeek.split('-W');
      if (parts.length !== 2) return viewWeek;
      return `${parts[0]}年 第 ${parts[1]} 週`;
  }, [viewWeek]);

  const getTypeName = (typeId) => SCORE_TYPES.find(t => t.id === typeId)?.label || typeId;

  // --- Handlers ---
  const handleScoreChange = (classId, val) => {
    setCurrentScores(prev => ({ ...prev, [classId]: val }));
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
      message: `確定要一次儲存 ${scoreCount} 筆【${typeName}】評分嗎？`,
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
            type: selectedType,
            grade: gradeNum,
            classId: String(classId),
            score: scoreNum,
            createdAt: timestamp,
            raterUid: raterUid,
            note: remarks // 儲存反映事項
          });
          opCount++;
        }
      });

      if (opCount > 0) {
        await batch.commit();
        showToast(`成功儲存 ${opCount} 筆評分！`, 'success');
        setCurrentScores({});
        setRemarks(''); // 清空反映事項
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

  // Settings & Admin Handlers
  const handleSettingsClick = () => {
    // 點擊設定時，開啟密碼輸入視窗
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const verifyAdminPassword = () => {
    if (adminPassword === 'admin888') {
      setShowAdminModal(false);
      setAdminPassword('');
      setTempClassCounts(classCounts); // Reset temp to current
      setActiveTab('settings');
      showToast('驗證成功', 'success');
    } else {
      showToast('密碼錯誤', 'error');
    }
  };

  const handleSettingsChange = (grade, value) => {
    const val = parseInt(value, 10);
    if (!isNaN(val) && val >= 0 && val <= 30) {
      setTempClassCounts(prev => ({ ...prev, [grade]: val }));
    }
  };

  const saveSettings = async () => {
    if (!user) return showToast("系統尚未連線", 'error');
    setIsSavingSettings(true);
    try {
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', SETTINGS_COLLECTION, 'config');
      await setDoc(docRef, { 
        classCounts: tempClassCounts,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
      setClassCounts(tempClassCounts);
      showToast("班級數量設定已更新", 'success');
      // 切換回評分頁面
      setActiveTab('score');
    } catch (e) {
      console.error("Save Settings Error:", e);
      showToast(`設定儲存失敗: ${e.message}`, 'error');
    } finally {
      setIsSavingSettings(false);
    }
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
    const classroomScore = stats?.classroom || 0;
    const exteriorScore = stats?.exterior || 0;
    const isClassroomActive = selectedType === 'classroom';
    const isExteriorActive = selectedType === 'exterior';

    return (
      <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-white p-3 rounded-lg shadow-sm border border-slate-200 gap-3">
        <div className="flex flex-row sm:flex-col items-center sm:items-start justify-between sm:justify-center w-full sm:w-32 pr-2">
          <div className="font-black text-xl text-slate-800">{classId}</div>
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
            <p className="text-slate-600 font-medium">系統載入中...</p>
          </div>
        </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 relative">
      
      {/* Admin Login Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-w-xs w-full overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex items-center gap-2">
              <Lock size={20}/>
              <h3 className="font-bold">管理員驗證</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-500 mb-3 font-bold">請輸入管理密碼：</p>
              <div className="relative">
                <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={16} />
                <input 
                  type="password" 
                  autoFocus
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && verifyAdminPassword()}
                  className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-800 outline-none font-bold tracking-widest text-lg"
                  placeholder="Password"
                />
              </div>
            </div>
            <div className="p-4 bg-slate-50 flex gap-3">
              <button 
                onClick={() => {
                  setShowAdminModal(false);
                  setAdminPassword('');
                }} 
                className="flex-1 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-lg transition-colors"
              >
                取消
              </button>
              <button 
                onClick={verifyAdminPassword} 
                className="flex-1 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-black transition-colors"
              >
                確認
              </button>
            </div>
          </div>
        </div>
      )}

      {/* General Modals */}
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

      {/* Toast */}
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
                系統正常運作中
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        
        {/* Main Tabs */}
        <div className="flex bg-white p-1 rounded-xl shadow-sm mb-6 border border-slate-200 overflow-x-auto">
          <button 
            onClick={() => setActiveTab('score')}
            className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'score' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <ClipboardList size={18} /> 評分
          </button>
          <button 
            onClick={() => setActiveTab('ranking')}
            className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'ranking' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <Trophy size={18} /> 榮譽榜
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'history' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <BarChart3 size={18} /> 紀錄
          </button>
          <button 
            onClick={handleSettingsClick}
            className={`flex-0 py-3 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'settings' ? 'bg-slate-700 text-white shadow-md' : 'text-slate-400 hover:bg-slate-50'}`}
          >
            <Settings size={18} /> 設定
          </button>
        </div>

        {/* SCORING TAB */}
        {activeTab === 'score' && (
          <div className="animate-fade-in">
            {/* Type Selector */}
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

            {/* Date & Grade Selector */}
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

            {/* List */}
            <div className="space-y-3 mb-6">
              {getClassesList(selectedGrade, classCounts).map(classId => (
                <ClassScoreRow 
                  key={classId} 
                  classId={classId} 
                  stats={currentWeekStats[classId] || {}} 
                />
              ))}
            </div>

            {/* Reflective Note Input (New) */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-20">
              <label className="block text-xs font-bold text-slate-400 mb-2 uppercase flex items-center gap-1">
                <MessageSquare size={14} /> 反映事項 (選填)
              </label>
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="有什麼突發狀況或備註事項嗎？請在此輸入..."
                className="w-full p-3 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm min-h-[80px]"
              />
            </div>

            {/* Floating Submit Button */}
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
                <div className="text-xs text-emerald-600 font-bold">(教室 + 外掃 總積分)</div>
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
               <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-800">最新評分紀錄</h3>
                    <span className="text-xs bg-white border border-slate-200 text-slate-500 px-2 py-1 rounded">最近 300 筆</span>
                  </div>
                  <AlertOctagon size={16} className="text-slate-400" />
               </div>
               <div className="max-h-[60vh] overflow-y-auto">
                 <table className="w-full text-sm">
                   <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 shadow-sm z-10">
                     <tr>
                       <th className="p-3 text-left">班級/日期</th>
                       <th className="p-3 text-left">類別</th>
                       <th className="p-3 text-right">分數</th>
                       <th className="p-3 w-10"></th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-100">
                     {scoresData.map(record => (
                       <tr key={record.id} className="hover:bg-slate-50 group">
                         <td className="p-3">
                           <div className="font-bold text-slate-700">{record.classId}</div>
                           <div className="text-xs text-slate-400">{record.date}</div>
                         </td>
                         <td className="p-3">
                           <div className="flex flex-col gap-1">
                            <span className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 w-fit
                              ${record.type === 'classroom' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
                              {record.type === 'classroom' ? <Home size={10}/> : <Trees size={10}/>}
                              {getTypeName(record.type)}
                            </span>
                            {/* 顯示 Reflective Note 如果存在 */}
                            {record.note && (
                              <div className="text-[10px] text-slate-500 flex items-start gap-1 max-w-[120px] leading-tight mt-1 bg-slate-100 p-1 rounded">
                                <MessageSquare size={10} className="mt-0.5 shrink-0" />
                                <span className="truncate">{record.note}</span>
                              </div>
                            )}
                           </div>
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
            <div className="text-center mt-4 text-xs text-slate-400">
                * 為了效能考量，僅顯示最新 300 筆資料。如需刪除舊資料請至 Firebase Console。
            </div>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === 'settings' && (
          <div className="animate-fade-in">
             <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-6">
                <div className="border-b border-slate-100 pb-4">
                  <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                    <Settings className="text-slate-500" />
                    班級數量設定
                  </h2>
                  <p className="text-sm text-slate-400 mt-1">
                    在此調整每個年級的班級總數，設定將即時套用到所有使用者的介面。
                  </p>
                </div>

                <div className="grid gap-6">
                  {GRADES.map(grade => (
                    <div key={grade} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <div>
                        <div className="font-bold text-slate-700 text-lg">{grade} 年級</div>
                        <div className="text-xs text-slate-400">
                          目前的範圍: {grade}01 - {grade}{String(tempClassCounts[grade]).padStart(2, '0')}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => handleSettingsChange(grade, tempClassCounts[grade] - 1)}
                          className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-100 flex items-center justify-center font-bold text-xl"
                        >
                          -
                        </button>
                        <div className="w-12 text-center font-black text-2xl text-emerald-600">
                          {tempClassCounts[grade]}
                        </div>
                        <button 
                          onClick={() => handleSettingsChange(grade, tempClassCounts[grade] + 1)}
                          className="w-10 h-10 rounded-full bg-white border border-slate-200 text-emerald-600 hover:bg-emerald-50 flex items-center justify-center font-bold text-xl"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-4 border-t border-slate-100">
                  <button 
                    onClick={saveSettings}
                    disabled={isSavingSettings}
                    className="w-full bg-slate-800 text-white py-4 rounded-xl font-bold text-lg hover:bg-black transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isSavingSettings ? (
                      '儲存設定中...'
                    ) : (
                      <>
                        <Save size={20} /> 儲存變更
                      </>
                    )}
                  </button>
                </div>
             </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;