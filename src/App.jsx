import React, { useState, useEffect, useMemo } from 'react';
import { 
  ClipboardList, Trophy, Save, Calendar, 
  ChevronLeft, ChevronRight, Trash2, BarChart3, 
  AlertTriangle, Lock, CheckCircle2,
  Trees, Home, Brush, AlertOctagon, Settings, KeyRound, MessageSquare,
  Printer, Medal
} from 'lucide-react';

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, onSnapshot, getDoc, setDoc,
  serverTimestamp, writeBatch, query, orderBy, limit
} from 'firebase/firestore';
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from 'firebase/auth';

// --- Configuration ---
let firebaseConfig;
let appId;

if (typeof __firebase_config !== 'undefined') {
  firebaseConfig = JSON.parse(__firebase_config);
  appId = typeof __app_id !== 'undefined' ? __app_id : "school-app";
} else {
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const COLLECTION_NAME = "school_cleanliness_scores_v1";
const SETTINGS_COLLECTION = "school_settings_v1"; 

// --- Constants & Helpers ---
const GRADES = [1, 2, 3];
const DEFAULT_SETTINGS = { 
  classCounts: { 1: 4, 2: 5, 3: 5 },
  semesterStart: '',
  semesterEnd: ''
};

const getClassesList = (grade, counts) => 
  Array.from({ length: counts[grade] || 0 }, (_, i) => `${grade}${String(i + 1).padStart(2, '0')}`);

const SCORE_TYPES = [
  { id: 'classroom', label: '教室整潔', icon: Home, color: 'text-blue-600', bg: 'bg-blue-100', border: 'border-blue-200' },
  { id: 'exterior', label: '外掃區域', icon: Trees, color: 'text-emerald-600', bg: 'bg-emerald-100', border: 'border-emerald-200' }
];

// 解決 UTC 造成的日期落後一天問題
const getLocalDateString = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split('T')[0];
};

// Get Week Number (改為以「週日」為一週的第一天)
const getWeekNumber = (d) => {
  if (!d || isNaN(d.getTime())) return "Invalid-Date";
  // 將日期加一天，把週日推移到週一，藉此讓 ISO 週次計算把「週日」視為一週的第一天
  const shifted = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 1));
  shifted.setUTCDate(shifted.getUTCDate() + 4 - (shifted.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((shifted - yearStart) / 86400000) + 1) / 7);
  return `${shifted.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

// 計算相對週次 (以開學當週的「週日」為基準)
const getRelativeWeekNumber = (viewWeekStr, semesterStartStr) => {
   if (!semesterStartStr || !viewWeekStr) return null;
   
   const parts = viewWeekStr.split('-W');
   if (parts.length !== 2) return null;
   const y = parseInt(parts[0], 10);
   const w = parseInt(parts[1], 10);
   
   const simple = new Date(y, 0, 1 + (w - 1) * 7);
   let dow = simple.getDay();
   if (dow === 0) dow = 7; 
   
   const ISOweekStart = simple;
   if (dow <= 4) {
       ISOweekStart.setDate(simple.getDate() - dow + 1);
   } else {
       ISOweekStart.setDate(simple.getDate() + 8 - dow);
   }
   
   const targetSunday = new Date(ISOweekStart);
   targetSunday.setDate(targetSunday.getDate() - 1);
   targetSunday.setHours(0,0,0,0);

   const startDate = new Date(semesterStartStr.replace(/-/g, '\/')); 
   if (isNaN(startDate)) return null;

   const startDow = startDate.getDay();
   const startSunday = new Date(startDate);
   startSunday.setDate(startDate.getDate() - startDow);
   startSunday.setHours(0,0,0,0);

   const diffTime = targetSunday.getTime() - startSunday.getTime();
   const diffWeeks = Math.round(diffTime / (86400000 * 7));
   return diffWeeks + 1;
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
  const [appSettings, setAppSettings] = useState(DEFAULT_SETTINGS);
  const [tempSettings, setTempSettings] = useState(DEFAULT_SETTINGS); 
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAction, setAdminAction] = useState('settings'); // 'settings' or 'clearAll'

  // UI State
  const [modalConfig, setModalConfig] = useState({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  
  // Scoring Form State
  const [selectedDate, setSelectedDate] = useState(getLocalDateString()); 
  const [selectedType, setSelectedType] = useState('classroom');
  const [selectedGrade, setSelectedGrade] = useState(1);
  const [currentScores, setCurrentScores] = useState({}); 
  const [remarks, setRemarks] = useState(''); 

  // Ranking View State
  const [viewWeek, setViewWeek] = useState(getWeekNumber(new Date()));

  // Auth
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

  // Load Settings
  useEffect(() => {
    if (!authReady || !user) return;
    const fetchSettings = async () => {
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', SETTINGS_COLLECTION, 'config');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          const loadedSettings = { ...DEFAULT_SETTINGS, ...data };
          setAppSettings(loadedSettings);
          setTempSettings(loadedSettings);
        }
      } catch (e) {}
    };
    fetchSettings();
  }, [authReady, user]);

  // Load Scores
  useEffect(() => {
    if (!authReady || !user) return;
    try {
        const q = query(
          collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME),
          orderBy('createdAt', 'desc'),
          limit(500) // 增加到 500 以利長期歷史排名計算
        );
        const unsubscribe = onSnapshot(q, (snapshot) => {
          const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          setScoresData(data);
          setLoading(false);
        }, (error) => {
          if (error.code !== 'permission-denied' && error.code !== 'failed-precondition') {
             showToast("無法讀取資料", 'error');
          }
          setLoading(false);
        });
        return () => unsubscribe();
    } catch (err) {
        setLoading(false);
    }
  }, [authReady, user]);

  useEffect(() => {
    setCurrentScores({});
    setRemarks('');
  }, [selectedType, selectedDate]); 

  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
  };

  const closeModal = () => {
    setModalConfig({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  };

  const currentWeekStats = useMemo(() => {
    const targetWeek = getWeekNumber(new Date(selectedDate)); 
    const filtered = scoresData.filter(d => d.week === targetWeek);
    const stats = {}; 
    GRADES.forEach(g => {
      getClassesList(g, appSettings.classCounts).forEach(c => {
        stats[c] = { classroom: 0, exterior: 0, total: 0 };
      });
    });

    filtered.forEach(record => {
      if (!stats[record.classId]) return;
      if (record.type === 'classroom') stats[record.classId].classroom += record.score;
      else if (record.type === 'exterior') stats[record.classId].exterior += record.score;
      stats[record.classId].total += record.score;
    });
    return stats; 
  }, [scoresData, selectedDate, appSettings.classCounts]);

  // 榮譽榜模擬引擎 (同分突破與連續三週邏輯)
  const rankingEngine = useMemo(() => {
    const allWeeks = [...new Set(scoresData.map(d => d.week))].sort();
    
    // 初始化班級歷史紀錄
    const classStats = {};
    GRADES.forEach(g => getClassesList(g, appSettings.classCounts).forEach(c => {
        classStats[c] = { firsts: 0, seconds: 0, streak: 0, lastWeekFirst: false };
    }));

    const rankingsByWeek = {};

    allWeeks.forEach((week) => {
        const weekData = scoresData.filter(d => d.week === week).sort((a,b) => (a.createdAt?.seconds||0) - (b.createdAt?.seconds||0));
        
        GRADES.forEach(grade => {
            const gradeClasses = getClassesList(grade, appSettings.classCounts);
            const totals = {};
            const firstScoreTime = {};
            gradeClasses.forEach(c => totals[c] = 0);
            
            weekData.forEach(record => {
                if (record.classId.startsWith(String(grade)) && totals[record.classId] !== undefined) {
                    totals[record.classId] += record.score;
                    if (!firstScoreTime[record.classId]) firstScoreTime[record.classId] = record.createdAt?.seconds || 0;
                }
            });

            // 基本排序
            let sorted = gradeClasses.map(c => ({ 
                classId: c, 
                total: totals[c],
                firstScoreTime: firstScoreTime[c] || Infinity,
                showStreakBadge: false
            })).sort((a, b) => b.total - a.total); 

            // 第一名同分突破 (Tie-breaker for 1st)
            if (sorted.length > 0 && sorted[0].total > 0) {
                const topScore = sorted[0].total;
                const topCandidates = sorted.filter(c => c.total === topScore);
                
                if (topCandidates.length > 1) {
                    topCandidates.sort((a, b) => {
                        // 1. 上週第一名優先
                        const aLast = classStats[a.classId].lastWeekFirst ? 1 : 0;
                        const bLast = classStats[b.classId].lastWeekFirst ? 1 : 0;
                        if (aLast !== bLast) return bLast - aLast;
                        // 2. 最少拿第一優先
                        const aFirsts = classStats[a.classId].firsts;
                        const bFirsts = classStats[b.classId].firsts;
                        if (aFirsts !== bFirsts) return aFirsts - bFirsts;
                        // 3. 最早拿到分數優先
                        if (a.firstScoreTime !== b.firstScoreTime) return a.firstScoreTime - b.firstScoreTime;
                        // 4. 雜湊隨機
                        const hashA = a.classId.charCodeAt(a.classId.length-1) + week.charCodeAt(week.length-1);
                        const hashB = b.classId.charCodeAt(b.classId.length-1) + week.charCodeAt(week.length-1);
                        return (hashA % 3) - (hashB % 3);
                    });
                    sorted.splice(0, topCandidates.length, ...topCandidates);
                }
            }

            // 第二名同分突破 (Tie-breaker for 2nd)
            if (sorted.length > 1 && sorted[1].total > 0) {
                const secondScore = sorted[1].total;
                const secondCandidates = sorted.filter(c => c.total === secondScore);
                
                if (secondCandidates.length > 1) {
                    secondCandidates.sort((a, b) => {
                        // 1. 最少獲獎(1st+2nd)優先
                        const aAwards = classStats[a.classId].firsts + classStats[a.classId].seconds;
                        const bAwards = classStats[b.classId].firsts + classStats[b.classId].seconds;
                        if (aAwards !== bAwards) return aAwards - bAwards;
                        // 2. 最早拿到分數優先
                        if (a.firstScoreTime !== b.firstScoreTime) return a.firstScoreTime - b.firstScoreTime;
                        // 3. 雜湊隨機
                        const hashA = a.classId.charCodeAt(a.classId.length-1) + week.charCodeAt(week.length-1);
                        const hashB = b.classId.charCodeAt(b.classId.length-1) + week.charCodeAt(week.length-1);
                        return (hashA % 3) - (hashB % 3);
                    });
                    const secondStartIndex = sorted.findIndex(c => c.total === secondScore);
                    sorted.splice(secondStartIndex, secondCandidates.length, ...secondCandidates);
                }
            }

            // 更新歷史統計與計算三連霸徽章
            gradeClasses.forEach(c => classStats[c].lastWeekFirst = false);
            let firstPlaceClass = null;

            if (sorted.length > 0 && sorted[0].total > 0) {
                firstPlaceClass = sorted[0].classId;
                classStats[firstPlaceClass].firsts += 1;
                classStats[firstPlaceClass].lastWeekFirst = true;
                classStats[firstPlaceClass].streak += 1;
                
                if (classStats[firstPlaceClass].streak === 3) {
                    sorted[0].showStreakBadge = true;
                    classStats[firstPlaceClass].streak = 0; // 觸發後重置
                }
            }
            if (sorted.length > 1 && sorted[1].total > 0) {
                classStats[sorted[1].classId].seconds += 1;
            }

            // 沒拿到第一名的連勝歸零
            gradeClasses.forEach(c => {
                if (c !== firstPlaceClass) classStats[c].streak = 0;
            });

            rankingsByWeek[week] = rankingsByWeek[week] || {};
            rankingsByWeek[week][grade] = sorted;
        });
    });

    return { 
        rankings: rankingsByWeek[viewWeek] || {},
        allRankings: rankingsByWeek,
        allWeeks: allWeeks
    };
  }, [scoresData, viewWeek, appSettings.classCounts]);

  const currentWeekLabel = useMemo(() => {
      const relWeek = getRelativeWeekNumber(viewWeek, appSettings.semesterStart);
      if (relWeek !== null) {
          if (relWeek > 0) return `本學期 第 ${relWeek} 週`;
          if (relWeek <= 0) return `開學前 第 ${Math.abs(relWeek - 1)} 週`;
      }
      const parts = viewWeek.split('-W');
      if (parts.length !== 2) return viewWeek;
      return `${parts[0]}年 第 ${parts[1]} 週`;
  }, [viewWeek, appSettings.semesterStart]);

  const getTypeName = (typeId) => SCORE_TYPES.find(t => t.id === typeId)?.label || typeId;

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
            raterUid: user.uid,
            note: remarks 
          });
          opCount++;
        }
      });

      if (opCount > 0) {
        await batch.commit();
        showToast(`成功儲存 ${opCount} 筆評分！`, 'success');
        setCurrentScores({});
        setRemarks(''); 
      } else {
        showToast("沒有有效的評分數據", 'error');
      }
    } catch (e) {
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

  // Admin & Settings Handlers
  const handleAdminAuthRequest = (action) => {
    setAdminAction(action);
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const verifyAdminPassword = () => {
    if (adminPassword === 'admin888') {
      setShowAdminModal(false);
      setAdminPassword('');
      showToast('驗證成功', 'success');
      
      if (adminAction === 'settings') {
        setTempSettings(appSettings);
        setActiveTab('settings');
      } else if (adminAction === 'clearAll') {
        confirmClearAll();
      }
    } else {
      showToast('密碼錯誤', 'error');
    }
  };

  const confirmClearAll = () => {
    setModalConfig({
      isOpen: true,
      type: 'delete',
      title: '嚴重警告：清空所有資料',
      message: '您確定要徹底刪除資料庫中「所有」的評分紀錄嗎？此動作無法復原！',
      onConfirm: executeClearAll
    });
  };

  const executeClearAll = async () => {
    closeModal();
    setSubmitting(true);
    try {
        // 分批刪除 (Firestore 限制 batch 500)
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME), limit(500));
        let count = 0;
        
        while (true) {
            const snapshot = await onSnapshotPromise(q);
            if (snapshot.empty) break;
            const batch = writeBatch(db);
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            count += snapshot.size;
        }
        showToast(`成功清空所有資料 (共 ${count} 筆)`, 'success');
    } catch (e) {
        showToast(`清空失敗: ${e.message}`, 'error');
    } finally {
        setSubmitting(false);
    }
  };

  // Helper for sequential deletion
  const onSnapshotPromise = (q) => new Promise((resolve, reject) => {
      const unsubscribe = onSnapshot(q, (snap) => {
          unsubscribe();
          resolve(snap);
      }, reject);
  });

  const handleSettingsChange = (field, value, grade = null) => {
    if (field === 'classCounts' && grade !== null) {
      const val = parseInt(value, 10);
      if (!isNaN(val) && val >= 0 && val <= 30) {
        setTempSettings(prev => ({ ...prev, classCounts: { ...prev.classCounts, [grade]: val } }));
      }
    } else {
      setTempSettings(prev => ({ ...prev, [field]: value }));
    }
  };

  const saveSettings = async () => {
    if (!user) return showToast("系統尚未連線", 'error');
    setIsSavingSettings(true);
    try {
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', SETTINGS_COLLECTION, 'config');
      await setDoc(docRef, { 
        ...tempSettings,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
      setAppSettings(tempSettings);
      showToast("設定已更新", 'success');
      setActiveTab('score');
    } catch (e) {
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

  const handlePrint = () => {
    window.print();
  };

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
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center shrink-0
                   ${score === v ? 'bg-red-500 text-white shadow-md scale-110 z-10' : 'text-red-400 hover:bg-red-100 bg-white border border-slate-100'}`}
               >
                 {v}
               </button>
             ))}
             <button
               onClick={() => handleScoreChange(classId, 0)}
               className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center shrink-0 mx-1
                 ${score === 0 ? 'bg-slate-500 text-white shadow-md scale-110 z-10' : 'text-slate-400 hover:bg-slate-200 bg-white border border-slate-100'}`}
             >
               0
             </button>
             {[1, 2, 3].map(v => (
               <button
                 key={v}
                 onClick={() => handleScoreChange(classId, v)}
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center shrink-0
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

  if (!authReady || loading) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100">
          <div className="flex flex-col items-center p-8 bg-white rounded-xl shadow-lg">
             <div className="animate-spin mb-4"><Brush className="text-emerald-500" size={32}/></div>
            <p className="text-slate-600 font-medium">系統載入中...</p>
          </div>
        </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 relative">
      
      {/* UI Modals (Hidden on Print) */}
      <div className="print:hidden">
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
                    type="password" autoFocus value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && verifyAdminPassword()}
                    className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-800 outline-none font-bold tracking-widest text-lg"
                    placeholder="Password"
                  />
                </div>
              </div>
              <div className="p-4 bg-slate-50 flex gap-3">
                <button onClick={() => setShowAdminModal(false)} className="flex-1 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-lg">取消</button>
                <button onClick={verifyAdminPassword} className="flex-1 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-black">確認</button>
              </div>
            </div>
          </div>
        )}

        {modalConfig.isOpen && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full overflow-hidden">
              <div className={`p-4 ${modalConfig.type === 'delete' ? 'bg-red-50' : 'bg-emerald-50'} border-b border-slate-100 flex items-center gap-3`}>
                {modalConfig.type === 'delete' ? <AlertTriangle className="text-red-500"/> : <CheckCircle2 className="text-emerald-500"/>}
                <h3 className="font-bold text-lg text-slate-800">{modalConfig.title}</h3>
              </div>
              <div className="p-6"><p className="text-slate-600 font-medium">{modalConfig.message}</p></div>
              <div className="p-4 bg-slate-50 flex gap-3">
                <button onClick={closeModal} className="flex-1 py-2.5 text-slate-500 font-bold hover:bg-slate-200 rounded-lg">取消</button>
                <button onClick={modalConfig.onConfirm} className={`flex-1 py-2.5 text-white font-bold rounded-lg shadow-lg active:scale-95 ${modalConfig.type === 'delete' ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>確定</button>
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

        <header className="bg-emerald-900 text-white p-4 shadow-lg sticky top-0 z-20">
          <div className="max-w-3xl mx-auto flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-600 rounded-lg"><Brush size={24} className="text-white" /></div>
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
          <div className="flex bg-white p-1 rounded-xl shadow-sm mb-6 border border-slate-200 overflow-x-auto">
            <button onClick={() => setActiveTab('score')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'score' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
              <ClipboardList size={18} /> 評分
            </button>
            <button onClick={() => setActiveTab('ranking')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'ranking' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
              <Trophy size={18} /> 榮譽榜
            </button>
            <button onClick={() => setActiveTab('history')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'history' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}>
              <BarChart3 size={18} /> 紀錄
            </button>
            <button onClick={() => handleAdminAuthRequest('settings')} className={`flex-0 py-3 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'settings' ? 'bg-slate-700 text-white shadow-md' : 'text-slate-400 hover:bg-slate-50'}`}>
              <Settings size={18} /> 設定
            </button>
          </div>

          {/* TAB: SCORE */}
          {activeTab === 'score' && (
            <div className="animate-fade-in">
              <div className="grid grid-cols-2 gap-3 mb-4">
                 {SCORE_TYPES.map(type => {
                   const isActive = selectedType === type.id;
                   const Icon = type.icon;
                   return (
                     <button key={type.id} onClick={() => setSelectedType(type.id)}
                       className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-2
                         ${isActive ? `border-${type.color.split('-')[1]} ${type.bg} ${type.color}` : 'border-slate-100 bg-white text-slate-400 hover:bg-slate-50'}`}>
                       <Icon size={24} strokeWidth={isActive ? 2.5 : 2}/><span className="font-bold">{type.label}</span>
                     </button>
                   )
                 })}
              </div>

              <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-4 space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-400 mb-1 uppercase">日期</label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-2.5 text-slate-400" size={16}/>
                    <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
                      className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm font-bold" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 mb-2 uppercase">選擇年級</label>
                  <div className="flex gap-2">
                    {GRADES.map(g => {
                      const hasUnsaved = Object.keys(currentScores).some(classId => classId.startsWith(String(g)));
                      return (
                        <button key={g} onClick={() => setSelectedGrade(g)}
                          className={`flex-1 py-2 rounded-lg font-bold text-sm transition-all relative ${selectedGrade === g ? 'bg-slate-800 text-white shadow-md ring-2 ring-offset-2 ring-slate-800' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
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

              <div className="space-y-3 mb-6">
                {getClassesList(selectedGrade, appSettings.classCounts).map(classId => (
                  <ClassScoreRow key={classId} classId={classId} stats={currentWeekStats[classId] || {}} />
                ))}
              </div>

              <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-20">
                <label className="block text-xs font-bold text-slate-400 mb-2 uppercase flex items-center gap-1">
                  <MessageSquare size={14} /> 反映事項 (選填)
                </label>
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
                  placeholder="有什麼突發狀況或備註事項嗎？請在此輸入..."
                  className="w-full p-3 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm min-h-[80px]" />
              </div>

              <div className="fixed bottom-6 left-0 right-0 px-4 z-30 max-w-3xl mx-auto">
                <button onClick={handleConfirmSubmit} disabled={submitting}
                  className={`w-full text-white py-4 rounded-xl shadow-xl font-bold text-lg flex items-center justify-center gap-2 active:scale-95 transition-transform disabled:opacity-70 disabled:scale-100
                    ${selectedType === 'classroom' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                  {submitting ? <span>儲存中...</span> : <><Save size={20} /> {Object.keys(currentScores).length > 0 ? `儲存 ${Object.keys(currentScores).length} 筆評分` : `儲存【${getTypeName(selectedType)}】評分`}</>}
                </button>
              </div>
            </div>
          )}

          {/* TAB: RANKING */}
          {activeTab === 'ranking' && (
            <div className="animate-fade-in space-y-6">
              <div className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                <button onClick={() => changeWeek(-1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronLeft size={20}/></button>
                <div className="text-center">
                  <div className="text-xs text-slate-400 font-bold uppercase tracking-wider">目前檢視</div>
                  <div className="text-xl font-black text-emerald-900">{currentWeekLabel}</div>
                  <div className="text-[10px] text-emerald-600 font-bold mt-1 bg-emerald-50 px-2 py-0.5 rounded-full inline-block">同分突破演算法生效中</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={handlePrint} className="p-2 bg-slate-100 text-slate-600 rounded-full hover:bg-slate-200" title="列印報表"><Printer size={20}/></button>
                  <button onClick={() => changeWeek(1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronRight size={20}/></button>
                </div>
              </div>

              {GRADES.map(grade => {
                const data = rankingEngine.rankings[grade] || [];
                const top1 = data[0];
                const top2 = data[1];

                return (
                  <div key={grade} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative">
                    {/* 連續三週徽章動畫 */}
                    {top1?.showStreakBadge && (
                       <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none opacity-90 animate-bounce">
                           <div className="bg-red-500 text-white px-4 py-2 rounded-full font-black text-lg shadow-2xl flex items-center gap-2 border-4 border-white">
                               <Medal size={24} /> 連續三週第一名！
                           </div>
                       </div>
                    )}
                    
                    <div className="bg-slate-50 p-3 border-b border-slate-100 flex justify-between items-center">
                      <h3 className="font-bold text-slate-700 flex items-center gap-2">
                        <span className="bg-emerald-600 text-white text-xs px-2 py-0.5 rounded">{grade} 年級</span>總排行榜
                      </h3>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 p-4 bg-gradient-to-b from-white to-slate-50">
                      <div className="flex flex-col items-center relative mt-4">
                        <Trophy className="text-yellow-400 drop-shadow-sm absolute -top-6" size={32} fill="currentColor"/>
                        <div className={`w-full ${top1?.showStreakBadge ? 'bg-red-50 border-red-300' : 'bg-yellow-50 border-yellow-200'} border-2 rounded-xl p-4 text-center shadow-sm relative z-10 transition-colors`}>
                          <div className={`text-xs font-bold uppercase mb-1 ${top1?.showStreakBadge ? 'text-red-600' : 'text-yellow-600'}`}>第一名</div>
                          <div className="text-3xl font-black text-slate-800 mb-1">{top1 ? top1.classId : '-'}</div>
                          <div className="text-sm font-bold text-slate-500 bg-white/50 rounded-lg py-1">{top1 ? `${top1.total > 0 ? '+' : ''}${top1.total}` : '--'} 分</div>
                        </div>
                      </div>
                      <div className="flex flex-col items-center relative mt-8">
                          <div className="absolute -top-5 bg-slate-200 text-slate-500 text-xs font-bold px-2 py-0.5 rounded-full border border-slate-300 z-20">第二名</div>
                          <div className="w-full bg-slate-50 border-2 border-slate-200 rounded-xl p-4 text-center shadow-sm relative z-10">
                          <div className="text-2xl font-bold text-slate-700 mb-1 opacity-80">{top2 ? top2.classId : '-'}</div>
                            <div className="text-sm font-bold text-slate-400">{top2 ? `${top2.total > 0 ? '+' : ''}${top2.total}` : '--'} 分</div>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-slate-100">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-400 text-xs uppercase">
                            <tr><th className="p-2 text-left pl-4">排名</th><th className="p-2 text-left">班級</th><th className="p-2 text-right pr-4">總分</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {data.slice(2, 5).map((item, idx) => (
                            <tr key={item.classId}>
                              <td className="p-2 pl-4 font-bold text-slate-400">#{idx + 3}</td>
                              <td className="p-2 font-medium text-slate-600">{item.classId}</td>
                              <td className={`p-2 pr-4 text-right font-bold ${item.total >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{item.total > 0 ? '+' : ''}{item.total}</td>
                            </tr>
                          ))}
                          {data.length > 5 && <tr><td colSpan="3" className="text-center p-2 text-xs text-slate-400 italic">僅顯示前 5 名</td></tr>}
                           {data.length === 0 && <tr><td colSpan="3" className="text-center p-6 text-slate-400">尚無資料</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* TAB: HISTORY */}
          {activeTab === 'history' && (
            <div className="animate-fade-in space-y-4">
              <div className="flex justify-end">
                  <button onClick={() => handleAdminAuthRequest('clearAll')} className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-lg border border-red-200 hover:bg-red-100 flex items-center gap-1 font-bold">
                    <Trash2 size={14}/> 全部清除
                  </button>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                 <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-800">最新評分紀錄</h3>
                      <span className="text-xs bg-white border border-slate-200 text-slate-500 px-2 py-1 rounded">最近 500 筆</span>
                    </div>
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
                              <button onClick={() => handleConfirmDelete(record.id)} className="text-slate-300 hover:text-red-500 transition-colors">
                                <Trash2 size={16} />
                              </button>
                           </td>
                         </tr>
                       ))}
                       {scoresData.length === 0 && <tr><td colSpan="4" className="p-8 text-center text-slate-400">無歷史資料</td></tr>}
                     </tbody>
                   </table>
                 </div>
              </div>
            </div>
          )}

          {/* TAB: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="animate-fade-in">
               <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-8">
                  
                  {/* Semester Dates */}
                  <div>
                    <div className="border-b border-slate-100 pb-2 mb-4">
                      <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Calendar className="text-slate-500" size={20}/>學期區間設定</h2>
                      <p className="text-xs text-slate-400 mt-1">設定開學日期後，榮譽榜將會自動計算「第幾週」。</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">學期開始日期</label>
                        <input type="date" value={tempSettings.semesterStart} onChange={(e) => handleSettingsChange('semesterStart', e.target.value)}
                          className="w-full p-2 border border-slate-200 rounded-lg bg-slate-50 outline-none text-sm font-bold focus:border-emerald-500" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">學期結束日期</label>
                        <input type="date" value={tempSettings.semesterEnd} onChange={(e) => handleSettingsChange('semesterEnd', e.target.value)}
                          className="w-full p-2 border border-slate-200 rounded-lg bg-slate-50 outline-none text-sm font-bold focus:border-emerald-500" />
                      </div>
                    </div>
                  </div>

                  {/* Class Counts */}
                  <div>
                    <div className="border-b border-slate-100 pb-2 mb-4">
                      <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Settings className="text-slate-500" size={20}/>班級數量設定</h2>
                    </div>
                    <div className="grid gap-4">
                      {GRADES.map(grade => (
                        <div key={grade} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-100">
                          <div>
                            <div className="font-bold text-slate-700 text-lg">{grade} 年級</div>
                            <div className="text-xs text-slate-400">範圍: {grade}01 - {grade}{String(tempSettings.classCounts[grade]).padStart(2, '0')}</div>
                          </div>
                          <div className="flex items-center gap-3">
                            <button onClick={() => handleSettingsChange('classCounts', tempSettings.classCounts[grade] - 1, grade)} className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-100 flex items-center justify-center font-bold text-xl">-</button>
                            <div className="w-12 text-center font-black text-2xl text-emerald-600">{tempSettings.classCounts[grade]}</div>
                            <button onClick={() => handleSettingsChange('classCounts', tempSettings.classCounts[grade] + 1, grade)} className="w-10 h-10 rounded-full bg-white border border-slate-200 text-emerald-600 hover:bg-emerald-50 flex items-center justify-center font-bold text-xl">+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100">
                    <button onClick={saveSettings} disabled={isSavingSettings} className="w-full bg-slate-800 text-white py-4 rounded-xl font-bold text-lg hover:bg-black transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                      {isSavingSettings ? '儲存設定中...' : <><Save size={20} /> 儲存變更</>}
                    </button>
                  </div>
               </div>
            </div>
          )}
        </main>
      </div>

      {}
      {/* 這是專門給列印用的隱藏排版，只有在按 Ctrl+P 或列印按鈕時才會顯示 */}
      <div className="hidden print:block p-4 font-sans max-w-4xl mx-auto text-black">
         <div className="text-center mb-8 border-b-2 border-black pb-4">
            <h1 className="text-4xl font-black mb-2 tracking-widest">校園整潔榮譽榜</h1>
            <h2 className="text-2xl font-bold">{currentWeekLabel}</h2>
         </div>

         {/* 當週排名表 */}
         <div className="mb-12">
           <h3 className="text-xl font-bold mb-4 bg-gray-200 p-2 text-center">當週各年級排名</h3>
           <table className="w-full border-collapse border-2 border-black text-center text-lg">
             <thead>
               <tr className="bg-gray-100 border-b-2 border-black">
                 <th className="border border-black p-3 w-1/3">年級</th>
                 <th className="border border-black p-3 w-1/3 text-xl font-black">第一名</th>
                 <th className="border border-black p-3 w-1/3">第二名</th>
               </tr>
             </thead>
             <tbody>
               {GRADES.map(grade => {
                 const data = rankingEngine.rankings[grade] || [];
                 const top1 = data[0]?.total > 0 ? data[0].classId : '-';
                 const top2 = data[1]?.total > 0 ? data[1].classId : '-';
                 return (
                   <tr key={grade} className="border-b border-black font-bold">
                     <td className="border border-black p-4 text-xl">{grade} 年級</td>
                     <td className="border border-black p-4 text-2xl">{top1}</td>
                     <td className="border border-black p-4 text-xl text-gray-700">{top2}</td>
                   </tr>
                 )
               })}
             </tbody>
           </table>
         </div>

         {/* 本學期歷週精簡總表 */}
         <div>
           <h3 className="text-xl font-bold mb-4 bg-gray-200 p-2 text-center">本學期歷次紀錄總表</h3>
           <table className="w-full border-collapse border-2 border-black text-center text-sm">
             <thead>
               <tr className="bg-gray-100 border-b-2 border-black">
                 <th className="border border-black p-2">週次</th>
                 {GRADES.map(g => <th key={g} className="border border-black p-2">{g}年級 (一 / 二)</th>)}
               </tr>
             </thead>
             <tbody>
               {rankingEngine.allWeeks.map(weekStr => {
                 // Format week label for table
                 let displayWeek = weekStr;
                 const rel = getRelativeWeekNumber(weekStr, appSettings.semesterStart);
                 if (rel !== null && rel > 0) displayWeek = `第 ${rel} 週`;
                 
                 return (
                   <tr key={weekStr} className="border-b border-gray-400">
                     <td className="border border-black p-2 font-bold bg-gray-50">{displayWeek}</td>
                     {GRADES.map(grade => {
                        const data = rankingEngine.allRankings[weekStr]?.[grade] || [];
                        const t1 = data[0]?.total > 0 ? data[0].classId : '-';
                        const t2 = data[1]?.total > 0 ? data[1].classId : '-';
                        return (
                          <td key={grade} className="border border-black p-2 font-bold">
                            <span className="text-black font-black text-base">{t1}</span>
                            <span className="text-gray-500 mx-1">/</span>
                            <span className="text-gray-700">{t2}</span>
                          </td>
                        )
                     })}
                   </tr>
                 )
               })}
               {rankingEngine.allWeeks.length === 0 && (
                 <tr><td colSpan={GRADES.length + 1} className="p-8 text-gray-500">尚無任何紀錄</td></tr>
               )}
             </tbody>
           </table>
           <p className="text-xs text-gray-500 mt-2 text-right">列印時間：{new Date().toLocaleString()}</p>
         </div>
      </div>
    </div>
  );
};

export default App;