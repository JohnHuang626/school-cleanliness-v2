import React, { useState, useEffect, useMemo } from 'react';
import { 
  ClipboardList, Trophy, Save, Calendar, 
  ChevronLeft, ChevronRight, Trash2, BarChart3, 
  AlertTriangle, Lock, CheckCircle2,
  Trees, Home, Brush, AlertOctagon, Settings, KeyRound, MessageSquare, Printer
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
const SETTINGS_COLLECTION = "school_settings_v1"; 

// --- Constants ---
const GRADES = [1, 2, 3];
const DEFAULT_CLASS_COUNTS = { 1: 4, 2: 5, 3: 5 };

const getClassesList = (grade, counts) => 
  Array.from({ length: counts[grade] || 0 }, (_, i) => `${grade}${String(i + 1).padStart(2, '0')}`);

const SCORE_TYPES = [
  { id: 'classroom', label: '教室整潔', icon: Home, color: 'text-blue-600', bg: 'bg-blue-100', border: 'border-blue-200' },
  { id: 'exterior', label: '外掃區域', icon: Trees, color: 'text-emerald-600', bg: 'bg-emerald-100', border: 'border-emerald-200' }
];

// Helper: 取得本地時區的 YYYY-MM-DD
const getLocalDateString = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split('T')[0];
};

// Helper: 絕對週次 (以星期日為一週的第一天)
const getAbsoluteWeekNumber = (d) => {
  if (!d || isNaN(d.getTime())) return "Invalid-Date";
  // 複製日期物件，避免修改原始物件
  const date = new Date(d.getTime());
  
  // 將時區設為 UTC 避免跨日時區問題，並將時間設為中午 12 點
  date.setUTCHours(12, 0, 0, 0);

  // 取得當天是星期幾 (0 = 星期日, 1 = 星期一, ... 6 = 星期六)
  const dayOfWeek = date.getUTCDay();

  // 將日期對齊到當週的星期四 (這是在 ISO 週曆法中決定週次歸屬的關鍵天)
  // 如果我們把星期日當作第一天，那週四就是該週的第 5 天 (index 4)
  date.setUTCDate(date.getUTCDate() + 4 - (dayOfWeek === 0 ? 0 : dayOfWeek)); 

  const year = date.getUTCFullYear();
  
  // 該年的第一天
  const yearStart = new Date(Date.UTC(year, 0, 1));
  
  // 計算相差的天數，再除以 7 得到週數
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
};

// Helper: 相對週次 (依照開學日計算)
const getRelativeWeekInfo = (targetDateStr, termStartDateStr, termEndDateStr) => {
  const targetDate = new Date(targetDateStr);
  const termStart = new Date(termStartDateStr);
  
  if (isNaN(targetDate.getTime()) || isNaN(termStart.getTime())) {
    return { label: getAbsoluteWeekNumber(targetDate), isBeforeTerm: false };
  }

  // 取得學期開始那天的「絕對週次」
  const termStartAbsWeek = getAbsoluteWeekNumber(termStart);
  const targetAbsWeek = getAbsoluteWeekNumber(targetDate);
  
  const [startYear, startWeek] = termStartAbsWeek.split('-W').map(Number);
  const [targetYear, targetWeek] = targetAbsWeek.split('-W').map(Number);
  
  // 計算絕對週數的差值 (簡化計算，假設沒有跨太多年的極端情況)
  // 假設一年有 52 週
  const weekDiff = ((targetYear - startYear) * 52) + (targetWeek - startWeek);
  
  const relativeWeek = weekDiff + 1; // 開學當週為第 1 週
  
  if (relativeWeek < 1) {
    return { label: `開學前 第 ${Math.abs(relativeWeek) + 1} 週`, isBeforeTerm: true };
  } else {
    return { label: `本學期 第 ${relativeWeek} 週`, isBeforeTerm: false };
  }
};


// 演算法: 完美同分突破 (Tie-Breaker)
const calculateRankings = (scoresData, targetWeek, classCounts, GRADES, termStartDate) => {
  // 1. 取得時間軸上所有相關的週次 (從開學到 targetWeek)
  const allWeeks = [...new Set(scoresData.map(d => d.week))].sort();
  const targetAbsWeekIndex = allWeeks.indexOf(targetWeek);
  
  // 如果找不到，或這是第一週
  let historyWeeks = [];
  if (targetAbsWeekIndex > 0) {
    historyWeeks = allWeeks.slice(0, targetAbsWeekIndex);
  }

  // 2. 模擬歷史以計算「累積獲獎次數」與「連霸紀錄」
  const classStats = {};
  GRADES.forEach(g => {
    getClassesList(g, classCounts).forEach(c => {
      classStats[c] = {
        totalWins: 0,
        firstPlaceWins: 0,
        currentStreak: 0,
        lastWeekFirstPlace: false,
        wasFirstPlaceTwoWeeksAgo: false
      };
    });
  });

  // 逐週重播歷史，更新 classStats
  historyWeeks.forEach((week, index) => {
    const weekScores = scoresData.filter(d => d.week === week);
    const weekTotals = {};
    weekScores.forEach(r => {
      if (weekTotals[r.classId] === undefined) weekTotals[r.classId] = 0;
      weekTotals[r.classId] += r.score;
    });

    GRADES.forEach(g => {
      const gradeClasses = Object.keys(weekTotals).filter(c => c.startsWith(String(g)));
      const sorted = gradeClasses.map(c => ({ classId: c, total: weekTotals[c] })).sort((a, b) => b.total - a.total);
      
      // 找出這週的第一名(可能有同分)和第二名
      let firstPlaceClasses = [];
      if (sorted.length > 0 && sorted[0].total > 0) {
         const topScore = sorted[0].total;
         firstPlaceClasses = sorted.filter(c => c.total === topScore).map(c => c.classId);
      }

      // 檢查是否是上一週 (針對 targetWeek 而言)
      const isLastWeek = index === historyWeeks.length - 1;
      const isTwoWeeksAgo = index === historyWeeks.length - 2;

      // 更新全班狀態
      getClassesList(g, classCounts).forEach(c => {
         const isFirstThisWeek = firstPlaceClasses.includes(c);
         
         if (isFirstThisWeek) {
            classStats[c].totalWins += 1;
            classStats[c].firstPlaceWins += 1;
            classStats[c].currentStreak += 1;
         } else {
            // 中斷連勝，但只有在它有確實拿到分數或是我們確信比賽有進行的狀況下才算中斷
            // 簡化邏輯：沒拿到第一就是中斷
            classStats[c].currentStreak = 0;
         }

         if (isLastWeek) {
            classStats[c].lastWeekFirstPlace = isFirstThisWeek;
         }
         if (isTwoWeeksAgo) {
            classStats[c].wasFirstPlaceTwoWeeksAgo = isFirstThisWeek;
         }
      });
    });
  });

  // 3. 計算目標週 (targetWeek) 的總分與初步排名
  const targetWeekScores = scoresData.filter(d => d.week === targetWeek);
  const targetTotals = {};
  
  // 記錄誰先拿到分數 (依照 createdAt 的順序)
  const firstScoreTime = {}; 

  GRADES.forEach(g => getClassesList(g, classCounts).forEach(c => targetTotals[c] = 0));

  targetWeekScores.forEach(record => {
    if (targetTotals[record.classId] !== undefined) {
      targetTotals[record.classId] += record.score;
      
      // 記錄該班級最早獲得分數的時間，用於 tie-breaker
      if (!firstScoreTime[record.classId] || (record.createdAt && record.createdAt.seconds < firstScoreTime[record.classId])) {
         firstScoreTime[record.classId] = record.createdAt ? record.createdAt.seconds : 9999999999;
      }
    }
  });

  // 穩定雜湊隨機 (基於班級與週次)
  const stringHash = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  };

  const result = {};
  const threeWeekWinners = [];

  GRADES.forEach(g => {
    const gradeClasses = Object.keys(targetTotals).filter(c => c.startsWith(String(g)));
    
    let sorted = gradeClasses.map(c => ({ 
      classId: c, 
      total: targetTotals[c],
      ...classStats[c],
      scoreTime: firstScoreTime[c] || 9999999999
    }));

    // 進行自訂排序 (Tie-Breaker 演算法)
    sorted.sort((a, b) => {
       // 1. 先比總分
       if (b.total !== a.total) return b.total - a.total;
       
       // 同分狀況處理：
       // 規則 A: 第一名同分時
       // 因為陣列已經依總分排，所以這裡比較的兩者如果總分等於目前的最高分，就是第一名爭奪戰
       const currentMaxScore = Math.max(...gradeClasses.map(c => targetTotals[c]));
       
       if (a.total === currentMaxScore && a.total > 0) {
          // 條件 1: 上週也是第一名的班級優先
          if (a.lastWeekFirstPlace !== b.lastWeekFirstPlace) {
             return a.lastWeekFirstPlace ? -1 : 1;
          }
          // 條件 2: 最少拿第一名的班級優先 (讓大家都有機會)
          if (a.firstPlaceWins !== b.firstPlaceWins) {
             return a.firstPlaceWins - b.firstPlaceWins;
          }
       } else if (a.total > 0) {
          // 規則 B: 非第一名的同分 (第二名爭奪)
          // 條件 1: 最少獲獎的班級優先
          if (a.totalWins !== b.totalWins) {
             return a.totalWins - b.totalWins; 
          }
       }

       // 通用條件 3: 當週最先拿到分數的班級優先
       if (a.scoreTime !== b.scoreTime) {
          return a.scoreTime - b.scoreTime;
       }

       // 通用條件 4: 穩定隨機 (保證同一週每次看結果都一樣)
       const hashA = stringHash(`${a.classId}-${targetWeek}`);
       const hashB = stringHash(`${b.classId}-${targetWeek}`);
       return hashA - hashB;
    });

    result[g] = sorted;

    // 檢查「連續三週第一名」徽章邏輯
    // 如果這週拿到第一名，並且加上過去的 streak 達到 2 (即前兩週也是第一)，就會觸發
    if (sorted.length > 0 && sorted[0].total > 0) {
       const winner = sorted[0];
       // currentStreak 是結算到上週為止的連霸次數
       if (winner.currentStreak >= 2) {
           // 達到3連霸 (或 6連霸, 9連霸... 只要是3的倍數)
           // 我們可以用取餘數來判斷：如果 (上週為止的 streak + 1這週) % 3 === 0
           if ((winner.currentStreak + 1) % 3 === 0) {
               threeWeekWinners.push(winner.classId);
           }
       }
    }
  });

  return { rankings: result, threeWeekWinners };
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
  const [tempClassCounts, setTempClassCounts] = useState(DEFAULT_CLASS_COUNTS);
  
  // 新增：學期開始與結束日期
  const [termStart, setTermStart] = useState('2026-08-30');
  const [termEnd, setTermEnd] = useState('2027-01-20');
  const [tempTermStart, setTempTermStart] = useState('2026-08-30');
  const [tempTermEnd, setTempTermEnd] = useState('2027-01-20');

  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAction, setAdminAction] = useState('settings'); // 'settings' or 'clearData'

  // UI State
  const [modalConfig, setModalConfig] = useState({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  
  // Scoring Form State
  const [selectedDate, setSelectedDate] = useState(getLocalDateString()); 
  const [selectedType, setSelectedType] = useState('classroom');
  const [selectedGrade, setSelectedGrade] = useState(1);
  const [currentScores, setCurrentScores] = useState({}); 
  const [remarks, setRemarks] = useState('');

  // Ranking View State (預設顯示今天的週次)
  const [viewWeekAbs, setViewWeekAbs] = useState(getAbsoluteWeekNumber(new Date()));

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
          if (data.termStart) {
            setTermStart(data.termStart);
            setTempTermStart(data.termStart);
          }
          if (data.termEnd) {
             setTermEnd(data.termEnd);
             setTempTermEnd(data.termEnd);
          }
        }
      } catch (e) {
        console.error("Error fetching settings:", e);
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

  const handlePrint = () => {
    window.print();
  };

  // --- Calculations ---
  const currentWeekStats = useMemo(() => {
    const targetWeek = getAbsoluteWeekNumber(new Date(selectedDate)); 
    const filtered = scoresData.filter(d => d.week === targetWeek);
    
    const stats = {}; 
    GRADES.forEach(g => {
      getClassesList(g, classCounts).forEach(c => {
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
  }, [scoresData, selectedDate, classCounts]);

  const { rankings: weeklyRankings, threeWeekWinners } = useMemo(() => {
    return calculateRankings(scoresData, viewWeekAbs, classCounts, GRADES, termStart);
  }, [scoresData, viewWeekAbs, classCounts, termStart]);


  const currentWeekLabel = useMemo(() => {
      // 假設 viewWeekAbs 格式為 '2026-W34'
      // 我們需要找到該週次的隨便一天，才能轉換成相對週次
      // 為了簡單起見，我們利用 getRelativeWeekInfo 函數，並給他一個由 viewWeekAbs 還原的日期
      const [year, week] = viewWeekAbs.split('-W').map(Number);
      
      // 找到該年的第一個星期日
      const simpleDate = new Date(Date.UTC(year, 0, 1));
      while(simpleDate.getUTCDay() !== 0) {
          simpleDate.setUTCDate(simpleDate.getUTCDate() + 1);
      }
      // 加上週數
      simpleDate.setUTCDate(simpleDate.getUTCDate() + (week - 1) * 7);

      const relativeInfo = getRelativeWeekInfo(simpleDate.toISOString().split('T')[0], termStart, termEnd);
      return relativeInfo.label;

  }, [viewWeekAbs, termStart, termEnd]);

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
      const weekNum = getAbsoluteWeekNumber(new Date(selectedDate));
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

  const handleConfirmClearAll = () => {
    setAdminAction('clearData');
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const executeClearAll = async () => {
    closeModal();
    setSubmitting(true);
    try {
      // 因為 Firebase 一次 Batch 上限是 500 筆，我們分批刪除
      let deletedCount = 0;
      let hasMore = true;
      
      while(hasMore) {
        const q = query(
           collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME),
           limit(400) // 保守抓取，避免超過 500
        );
        const snapshot = await getDocs(q);
        
        if (snapshot.empty) {
           hasMore = false;
           break;
        }

        const batch = writeBatch(db);
        snapshot.docs.forEach(doc => {
           batch.delete(doc.ref);
        });
        await batch.commit();
        deletedCount += snapshot.docs.length;
      }
      
      showToast(`已成功清空所有 ${deletedCount} 筆資料`, 'success');
    } catch (e) {
      console.error("Clear All Error:", e);
      showToast(`清空失敗: ${e.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // Settings & Admin Handlers
  const handleSettingsClick = () => {
    setAdminAction('settings');
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const verifyAdminPassword = () => {
    if (adminPassword === 'admin888') {
      setShowAdminModal(false);
      setAdminPassword('');
      
      if (adminAction === 'settings') {
         setTempClassCounts(classCounts); 
         setTempTermStart(termStart);
         setTempTermEnd(termEnd);
         setActiveTab('settings');
         showToast('驗證成功', 'success');
      } else if (adminAction === 'clearData') {
         // 確認要刪除
         setModalConfig({
           isOpen: true,
           type: 'delete',
           title: '⚠️ 嚴重警告：清空所有資料',
           message: '您即將刪除資料庫內所有的整潔評分紀錄，此動作無法復原！請問確定要執行嗎？',
           onConfirm: executeClearAll
         });
      }
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
        termStart: tempTermStart,
        termEnd: tempTermEnd,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
      setClassCounts(tempClassCounts);
      setTermStart(tempTermStart);
      setTermEnd(tempTermEnd);
      showToast("設定已更新", 'success');
      setActiveTab('score');
    } catch (e) {
      console.error("Save Settings Error:", e);
      showToast(`設定儲存失敗: ${e.message}`, 'error');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const changeWeek = (delta) => {
    const [year, week] = viewWeekAbs.split('-W').map(Number);
    if (!year || !week) return;
    let newYear = year;
    let newWeek = week + delta;
    
    if (newWeek > 52) { newWeek = 1; newYear++; }
    if (newWeek < 1) { newWeek = 52; newYear--; }
    setViewWeekAbs(`${newYear}-W${String(newWeek).padStart(2, '0')}`);
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in print:hidden">
          <div className="bg-white rounded-xl shadow-2xl max-w-xs w-full overflow-hidden">
            <div className={`p-4 ${adminAction === 'clearData' ? 'bg-red-600' : 'bg-slate-900'} text-white flex items-center gap-2`}>
              <Lock size={20}/>
              <h3 className="font-bold">{adminAction === 'clearData' ? '高權限管理員驗證' : '管理員驗證'}</h3>
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
                className={`flex-1 py-2 ${adminAction === 'clearData' ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-black'} text-white font-bold rounded-lg transition-colors`}
              >
                確認
              </button>
            </div>
          </div>
        </div>
      )}

      {/* General Modals */}
      {modalConfig.isOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-fade-in print:hidden">
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
      <div className={`fixed bottom-24 left-1/2 transform -translate-x-1/2 z-50 transition-all duration-300 print:hidden ${toast.show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10 pointer-events-none'}`}>
        <div className={`flex items-center gap-3 px-6 py-3 rounded-full shadow-2xl border ${toast.type === 'error' ? 'bg-red-600 text-white border-red-700' : 'bg-emerald-600 text-white border-emerald-700'}`}>
          {toast.type === 'error' ? <AlertTriangle size={20} className="animate-pulse"/> : <CheckCircle2 size={20}/>}
          <span className="font-bold tracking-wide">{toast.message}</span>
        </div>
      </div>

      {/* --- 網頁正常版面 (列印時隱藏) --- */}
      <div className="print:hidden">
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
            {activeTab === 'ranking' && (
               <button onClick={handlePrint} className="bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-lg flex items-center gap-2 text-sm font-bold transition-colors">
                  <Printer size={16} />
                  列印報表
               </button>
            )}
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

              {/* Reflective Note Input */}
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
                  <div className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-1">目前檢視 (依學期)</div>
                  <div className="text-xl font-black text-emerald-900">{currentWeekLabel}</div>
                  <div className="text-[10px] text-emerald-600 font-bold mt-1">(系統週次: {viewWeekAbs})</div>
                </div>
                <button onClick={() => changeWeek(1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronRight size={20}/></button>
              </div>

              {GRADES.map(grade => {
                const data = weeklyRankings[grade] || [];
                const top1 = data[0];
                const top2 = data[1];

                const isTop1ThreeWeek = top1 && threeWeekWinners.includes(top1.classId);

                return (
                  <div key={grade} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative">
                    {/* 三連霸特殊標記 (網頁版) */}
                    {isTop1ThreeWeek && (
                       <div className="absolute top-2 right-2 bg-red-500 text-white text-xs font-black px-3 py-1 rounded-full shadow-lg z-20 animate-bounce border-2 border-white">
                         連續三週第一名 🏆
                       </div>
                    )}
                    
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
                        <div className={`w-full ${isTop1ThreeWeek ? 'bg-red-50 border-red-300' : 'bg-yellow-50 border-yellow-200'} border-2 rounded-xl p-4 text-center shadow-sm relative z-10 transition-colors`}>
                          <div className={`text-xs font-bold ${isTop1ThreeWeek ? 'text-red-600' : 'text-yellow-600'} uppercase mb-1`}>第一名</div>
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
                    <button 
                       onClick={handleConfirmClearAll}
                       className="text-xs bg-red-100 hover:bg-red-200 text-red-600 font-bold px-3 py-1.5 rounded-lg border border-red-200 flex items-center gap-1 transition-colors"
                    >
                       <Trash2 size={12} /> 全部清除
                    </button>
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
                  * 為了效能考量，僅顯示最新 300 筆資料。
              </div>
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (
            <div className="animate-fade-in">
               <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-8">
                  {/* 學期日期設定 */}
                  <div className="space-y-4">
                    <div className="border-b border-slate-100 pb-3">
                      <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                        <Calendar className="text-slate-500" />
                        學期日期設定
                      </h2>
                      <p className="text-sm text-slate-400 mt-1">
                        設定開學日期後，榮譽榜上的週次將會以該日期所在的當週自動計算為「第 1 週」。
                      </p>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-bold text-slate-600 mb-2">學期開始日期</label>
                        <input 
                          type="date"
                          value={tempTermStart}
                          onChange={(e) => setTempTermStart(e.target.value)}
                          className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-600 mb-2">學期結束日期</label>
                        <input 
                          type="date"
                          value={tempTermEnd}
                          onChange={(e) => setTempTermEnd(e.target.value)}
                          className="w-full p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 班級數量設定 */}
                  <div className="space-y-4">
                    <div className="border-b border-slate-100 pb-3">
                      <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                        <Settings className="text-slate-500" />
                        班級數量設定
                      </h2>
                      <p className="text-sm text-slate-400 mt-1">
                        在此調整每個年級的班級總數，設定將即時套用到所有使用者的介面。
                      </p>
                    </div>

                    <div className="grid gap-4">
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

      {/* --- 列印專用版面 (這部分代碼已經修復並確保完整，使用原生 CSS 來控制列印顯示) --- */}
      <style>{`
        @media print {
          .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          body { background: white; margin: 0; padding: 0; }
        }
        @media screen {
          .print\\:block { display: none !important; }
        }
      `}</style>
      
      <div className="print:block bg-white p-8 text-black font-sans w-full max-w-none m-0">
        <div className="text-center mb-8 border-b-2 border-black pb-4">
          <h1 className="text-3xl font-black mb-2">校園整潔榮譽榜</h1>
          <h2 className="text-xl font-bold text-gray-700">{currentWeekLabel}</h2>
        </div>

        {/* 表格一：當週一二名 */}
        <h3 className="text-xl font-bold mb-3 border-l-4 border-black pl-2">當週各年級前兩名</h3>
        <table className="w-full border-collapse border border-black mb-12 text-center">
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-black p-3 font-bold w-1/4">年級</th>
              <th className="border border-black p-3 font-bold text-lg w-3/8">第一名</th>
              <th className="border border-black p-3 font-bold w-3/8">第二名</th>
            </tr>
          </thead>
          <tbody>
            {GRADES.map(g => {
              const top1 = weeklyRankings[g]?.[0]?.classId || '-';
              const top2 = weeklyRankings[g]?.[1]?.classId || '-';
              
              // 判斷當週的第一名是否為連續三週霸主
              const isThreeWeekWinner = top1 !== '-' && threeWeekWinners.includes(top1);

              return (
                <tr key={g}>
                  <td className="border border-black p-3 font-bold">{g} 年級</td>
                  <td className="border border-black p-3">
                    <span className="font-black text-2xl align-middle">{top1}</span>
                    {isThreeWeekWinner && (
                      <span className="ml-3 text-sm font-black px-2 py-0.5 border-2 border-black rounded-full align-middle whitespace-nowrap">
                        連續三週第一名
                      </span>
                    )}
                  </td>
                  <td className="border border-black p-3 font-bold text-gray-700 text-lg">{top2}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* 表格二：本學期歷週精簡紀錄 */}
        <h3 className="text-xl font-bold mb-3 border-l-4 border-black pl-2">本學期歷週排名紀錄 (第一名 / 第二名)</h3>
        
        {/* 建立本學期到目前為止的所有週次陣列 */}
        {(() => {
           // 從 scoresData 取出本學期的所有週次
           const allTermWeeks = [...new Set(scoresData.map(d => d.week))].sort((a,b) => b.localeCompare(a));
           
           if (allTermWeeks.length === 0) {
              return <div className="p-4 border border-black text-center italic">尚無歷史紀錄</div>;
           }

           return (
             <table className="w-full border-collapse border border-black text-center text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border border-black p-2 font-bold w-1/4">週次</th>
                    {GRADES.map(g => (
                       <th key={g} className="border border-black p-2 font-bold">{g} 年級</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                   {allTermWeeks.map(w => {
                      // 將絕對週次轉為相對週次文字
                      const [year, weekStr] = w.split('-W').map(Number);
                      const simpleDate = new Date(Date.UTC(year, 0, 1));
                      while(simpleDate.getUTCDay() !== 0) {
                          simpleDate.setUTCDate(simpleDate.getUTCDate() + 1);
                      }
                      simpleDate.setUTCDate(simpleDate.getUTCDate() + (weekStr - 1) * 7);
                      const label = getRelativeWeekInfo(simpleDate.toISOString().split('T')[0], termStart, termEnd).label;

                      // 取得該週的歷史排名 (為了簡單起見，我們利用前面定義好的 calculateRankings)
                      const histRankings = calculateRankings(scoresData, w, classCounts, GRADES, termStart).rankings;

                      return (
                        <tr key={w}>
                           <td className="border border-black p-2 font-bold whitespace-nowrap">{label}</td>
                           {GRADES.map(g => {
                              const t1 = histRankings[g]?.[0]?.classId || '-';
                              const t2 = histRankings[g]?.[1]?.classId || '-';
                              return (
                                 <td key={g} className="border border-black p-2">
                                    <span className="font-bold">{t1}</span> / <span className="text-gray-600">{t2}</span>
                                 </td>
                              )
                           })}
                        </tr>
                      )
                   })}
                </tbody>
             </table>
           )
        })()}
        
        <div className="mt-8 text-right text-xs text-gray-500">
           列印時間: {new Date().toLocaleString('zh-TW')}
        </div>
      </div>
    </div>
  );
};

export default App;