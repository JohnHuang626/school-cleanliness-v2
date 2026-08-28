import React, { useState, useEffect, useMemo } from 'react';
import { 
  ClipboardList, Trophy, Save, Calendar, 
  ChevronLeft, ChevronRight, Trash2, BarChart3, 
  AlertTriangle, Lock, CheckCircle2,
  Trees, Home, Brush, Settings, KeyRound, 
  MessageSquare, Printer, Map, Image as ImageIcon, Upload, X
} from 'lucide-react';

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, collection, doc, onSnapshot, getDoc, setDoc,
  serverTimestamp, writeBatch, query, orderBy, limit, getDocs
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

// --- Constants & Defaults ---
const GRADES = [1, 2, 3];
const DEFAULT_CLASS_COUNTS = { 1: 4, 2: 5, 3: 5 };

// 動態計算當前學期的預設起始與結束日
const d = new Date();
const currentYear = d.getFullYear();
const isFall = d.getMonth() >= 7; // 8月(7)之後視為上學期
const DEFAULT_SEMESTER_START = isFall ? `${currentYear}-08-30` : `${currentYear}-02-11`;
const DEFAULT_SEMESTER_END = isFall ? `${currentYear+1}-01-20` : `${currentYear}-06-30`;

const getClassesList = (grade, counts) => 
  Array.from({ length: counts[grade] || 0 }, (_, i) => `${grade}${String(i + 1).padStart(2, '0')}`);

const SCORE_TYPES = [
  { id: 'classroom', label: '教室整潔', icon: Home, color: 'text-blue-600', bg: 'bg-blue-100', border: 'border-blue-200' },
  { id: 'exterior', label: '外掃區域', icon: Trees, color: 'text-emerald-600', bg: 'bg-emerald-100', border: 'border-emerald-200' }
];

const getLocalDateString = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().split('T')[0];
};

// Helper: 取得週次 (以星期日為一週的第一天)
const getWeekNumber = (d) => {
  if (!d || isNaN(d.getTime())) return "Invalid-Date";
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const dayOfYear = Math.floor((date - yearStart) / 86400000) + 1;
  const weekNo = Math.ceil((dayOfYear + yearStart.getUTCDay()) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

// 將週字串 (如 2026-W34) 轉為該週的星期日 Date 物件
const getSundayFromWeek = (weekStr) => {
  const parts = weekStr.split('-W');
  if (parts.length !== 2) return new Date();
  const y = parseInt(parts[0], 10);
  const w = parseInt(parts[1], 10);
  
  const yearStart = new Date(y, 0, 1);
  const startDow = yearStart.getDay(); // 0 is Sunday
  const sunday = new Date(y, 0, 1 - startDow + (w - 1) * 7);
  return sunday;
};

// 計算相對週次 (以開學當週的星期日為基準)
const getRelativeWeekNumber = (viewWeekStr, semesterStartStr) => {
   if (!semesterStartStr) return null;
   const targetDate = getSundayFromWeek(viewWeekStr);
   // 替換 - 為 / 確保 JS 判定為本地時區，而非 UTC
   const startDate = new Date(semesterStartStr.replace(/-/g, '\/')); 
   
   if (isNaN(startDate)) return null;

   const startDow = startDate.getDay(); // 0 is Sunday
   const startSunday = new Date(startDate);
   startSunday.setDate(startDate.getDate() - startDow);
   startSunday.setHours(0,0,0,0);
   targetDate.setHours(0,0,0,0);

   const diffTime = targetDate.getTime() - startSunday.getTime();
   const diffWeeks = Math.round(diffTime / (86400000 * 7));
   return diffWeeks + 1; // 開學當週為第 1 週
};

const App = () => {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState('score');
  const [scoresData, setScoresData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Settings & Admin State
  const [classCounts, setClassCounts] = useState(DEFAULT_CLASS_COUNTS);
  const [tempClassCounts, setTempClassCounts] = useState(DEFAULT_CLASS_COUNTS);
  
  const [semesterStart, setSemesterStart] = useState(DEFAULT_SEMESTER_START);
  const [semesterEnd, setSemesterEnd] = useState(DEFAULT_SEMESTER_END);
  const [tempSemesterStart, setTempSemesterStart] = useState(DEFAULT_SEMESTER_START);
  const [tempSemesterEnd, setTempSemesterEnd] = useState(DEFAULT_SEMESTER_END);

  // 新增：掃區分配圖 State
  const [cleaningMapImage, setCleaningMapImage] = useState(null);
  const [tempCleaningMapImage, setTempCleaningMapImage] = useState(null);
  const [showMapModal, setShowMapModal] = useState(false);

  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminAction, setAdminAction] = useState(null);

  const [modalConfig, setModalConfig] = useState({ isOpen: false, type: '', title: '', message: '', onConfirm: null });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  
  const [selectedDate, setSelectedDate] = useState(getLocalDateString());
  const [selectedType, setSelectedType] = useState('classroom');
  const [selectedGrade, setSelectedGrade] = useState(1);
  const [currentScores, setCurrentScores] = useState({}); 
  const [remarks, setRemarks] = useState(''); 
  
  const [viewWeek, setViewWeek] = useState(() => {
    return getWeekNumber(new Date());
  });

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) {
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
          if (data.semesterStart) {
            setSemesterStart(data.semesterStart);
            setTempSemesterStart(data.semesterStart);
          }
          if (data.semesterEnd) {
            setSemesterEnd(data.semesterEnd);
            setTempSemesterEnd(data.semesterEnd);
          }
          if (data.cleaningMapImage) {
            setCleaningMapImage(data.cleaningMapImage);
            setTempCleaningMapImage(data.cleaningMapImage);
          }
        }
      } catch (e) {
        console.error("Error fetching settings:", e);
      }
    };
    fetchSettings();
  }, [authReady, user]);

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

  const { rankings: weeklyRankings, threeWeekWinners, semesterHistory } = useMemo(() => {
    const getStableRandom = (str) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
      return h;
    };

    const allWeeksSet = new Set(scoresData.map(d => d.week).filter(w => w <= viewWeek));
    allWeeksSet.add(viewWeek);
    const allWeeks = Array.from(allWeeksSet).sort();

    let firstPlaceCounts = {};
    let awardCounts = {};
    let lastWeekFirsts = [];
    let streaks = {}; 
    let currentWeekResults = {};
    let currentThreeWeekWinners = [];
    let semesterHistoryData = []; 

    allWeeks.forEach(week => {
      // 檢查此週是否為開學前的週次 (過濾掉暑輔或開學前的打掃)
      const relW = getRelativeWeekNumber(week, semesterStart);
      const isBeforeSemester = relW !== null && relW <= 0;

      const weekRecords = scoresData.filter(d => d.week === week);
      const currentTotals = {};
      const earliestScoreTime = {};

      GRADES.forEach(g => getClassesList(g, classCounts).forEach(c => currentTotals[c] = 0));

      weekRecords.forEach(r => {
        if (currentTotals[r.classId] !== undefined) currentTotals[r.classId] += r.score;
        if (r.score > 0 && r.createdAt) {
          const time = r.createdAt.seconds || 0;
          if (!earliestScoreTime[r.classId] || time < earliestScoreTime[r.classId]) {
            earliestScoreTime[r.classId] = time;
          }
        }
      });

      let currentWeekFirsts = [];
      let currentWeekSeconds = [];
      const resultForWeek = {};
      const newThreeWeekWinners = [];

      GRADES.forEach(g => {
        let classData = getClassesList(g, classCounts).map(c => ({ classId: c, total: currentTotals[c] }));
        
        let top1 = null;
        let top2 = null;
        let sortedClasses = [];

        const classesWithScore = classData.filter(c => c.total > 0);

        if (classesWithScore.length > 0) {
            // --- 【第一輪選拔】：決定第一名 ---
            const highestScore = Math.max(...classesWithScore.map(c => c.total));
            const candidatesForFirst = classesWithScore.filter(c => c.total === highestScore);
            
            candidatesForFirst.sort((a, b) => {
                const aLastFirst = lastWeekFirsts.includes(a.classId);
                const bLastFirst = lastWeekFirsts.includes(b.classId);
                if (aLastFirst !== bLastFirst) return aLastFirst ? -1 : 1; 

                const aFirsts = firstPlaceCounts[a.classId] || 0;
                const bFirsts = firstPlaceCounts[b.classId] || 0;
                if (aFirsts !== bFirsts) return aFirsts - bFirsts; 

                const aTime = earliestScoreTime[a.classId] || Infinity;
                const bTime = earliestScoreTime[b.classId] || Infinity;
                if (aTime !== bTime) return aTime - bTime; 

                const aRand = getStableRandom(a.classId + week);
                const bRand = getStableRandom(b.classId + week);
                return aRand - bRand; 
            });
            top1 = candidatesForFirst[0];

            // --- 【第二輪選拔】：決定第二名 ---
            const remainingClasses = classesWithScore.filter(c => c.classId !== top1.classId);
            
            if (remainingClasses.length > 0) {
                const highestRemainingScore = Math.max(...remainingClasses.map(c => c.total));
                const candidatesForSecond = remainingClasses.filter(c => c.total === highestRemainingScore);
                
                candidatesForSecond.sort((a, b) => {
                    const aAwards = awardCounts[a.classId] || 0;
                    const bAwards = awardCounts[b.classId] || 0;
                    if (aAwards !== bAwards) return aAwards - bAwards; 

                    const aTime = earliestScoreTime[a.classId] || Infinity;
                    const bTime = earliestScoreTime[b.classId] || Infinity;
                    if (aTime !== bTime) return aTime - bTime; 

                    const aRand = getStableRandom(a.classId + week);
                    const bRand = getStableRandom(b.classId + week);
                    return aRand - bRand; 
                });
                top2 = candidatesForSecond[0];
            }
        }

        if (top1) sortedClasses.push(top1);
        if (top2) sortedClasses.push(top2);
        
        let others = classData.filter(c => c.classId !== top1?.classId && c.classId !== top2?.classId);
        others.sort((a, b) => {
            if (a.total !== b.total) return b.total - a.total; 
            return getStableRandom(a.classId + week) - getStableRandom(b.classId + week); 
        });
        
        sortedClasses = sortedClasses.concat(others);
        resultForWeek[g] = sortedClasses;

        // 如果「不是」開學前，才累積獲獎紀錄與連勝紀錄
        if (!isBeforeSemester) {
          if (top1) {
            currentWeekFirsts.push(top1.classId);
            firstPlaceCounts[top1.classId] = (firstPlaceCounts[top1.classId] || 0) + 1;
            awardCounts[top1.classId] = (awardCounts[top1.classId] || 0) + 1;
          }
          if (top2) {
            currentWeekSeconds.push(top2.classId);
            awardCounts[top2.classId] = (awardCounts[top2.classId] || 0) + 1;
          }
        }
      });

      // 如果「不是」開學前，才更新連勝機制；如果是開學前的最後一週，將所有人的連勝歸零
      if (!isBeforeSemester) {
        GRADES.forEach(g => {
          getClassesList(g, classCounts).forEach(classId => {
              if (currentWeekFirsts.includes(classId)) {
                  streaks[classId] = (streaks[classId] || 0) + 1;
                  if (streaks[classId] === 3) {
                      newThreeWeekWinners.push(classId); 
                      streaks[classId] = 0; 
                  }
              } else {
                  streaks[classId] = 0; 
              }
          });
        });
      } else {
         // 開學前的週次，強制中斷連勝紀錄（防止跨學期連勝）
         streaks = {};
         lastWeekFirsts = [];
      }

      if (!isBeforeSemester) {
         lastWeekFirsts = currentWeekFirsts;
      }

      semesterHistoryData.push({
        week: week,
        rankings: resultForWeek
      });

      if (week === viewWeek) {
        currentWeekResults = resultForWeek;
        currentThreeWeekWinners = newThreeWeekWinners;
      }
    });

    if (Object.keys(currentWeekResults).length === 0) {
        GRADES.forEach(g => {
            currentWeekResults[g] = getClassesList(g, classCounts).map(c => ({ classId: c, total: 0 }));
        });
    }

    return {
        rankings: currentWeekResults,
        threeWeekWinners: currentThreeWeekWinners,
        semesterHistory: semesterHistoryData
    };
  }, [scoresData, viewWeek, classCounts, semesterStart]);

  const currentWeekLabel = useMemo(() => {
      const parts = viewWeek.split('-W');
      if (parts.length !== 2) return viewWeek;
      
      if (semesterStart) {
        const relWeek = getRelativeWeekNumber(viewWeek, semesterStart);
        if (relWeek !== null) {
           if (relWeek > 0) return `第 ${relWeek} 週`;
           else return `開學前 第 ${Math.abs(relWeek - 1)} 週`;
        }
      }
      return `第 ${parts[1]} 週`;
  }, [viewWeek, semesterStart]);

  const realCurrentWeekLabel = useMemo(() => {
      const currentRealWeekStr = getWeekNumber(new Date());
      if (semesterStart) {
        const relWeek = getRelativeWeekNumber(currentRealWeekStr, semesterStart);
        if (relWeek !== null) {
           if (relWeek > 0) return `第 ${relWeek} 週`;
           else return `開學前 第 ${Math.abs(relWeek - 1)} 週`;
        }
      }
      const parts = currentRealWeekStr.split('-W');
      if (parts.length === 2) return `第 ${parts[1]} 週`;
      return currentRealWeekStr;
  }, [semesterStart]);

  const getTypeName = (typeId) => SCORE_TYPES.find(t => t.id === typeId)?.label || typeId;

  const handleScoreChange = (classId, val) => setCurrentScores(prev => ({ ...prev, [classId]: val }));

  // 新增：處理圖片上傳並進行壓縮
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // 檢查檔案類型
    if (!file.type.startsWith('image/')) {
        return showToast('請上傳圖片檔案 (JPG, PNG)', 'error');
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // 利用 Canvas 進行圖片壓縮與縮放 (限制最大邊長 1200px)
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        // 壓縮成 0.7 品質的 JPEG (非常節省資料庫空間)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        setTempCleaningMapImage(dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleConfirmSubmit = () => {
    if (!user) return showToast("系統尚未連線", 'error');
    const scoreCount = Object.keys(currentScores).length;
    if (scoreCount === 0) return showToast("請至少評分一個班級", 'error');
    if (!selectedDate) return showToast("請選擇日期", 'error');

    setModalConfig({
      isOpen: true,
      type: 'confirm',
      title: '確認儲存',
      message: `確定要一次儲存 ${scoreCount} 筆【${getTypeName(selectedType)}】評分嗎？`,
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
      } else showToast("沒有有效的評分數據", 'error');
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

  const handleSettingsClick = () => {
    setAdminAction('settings');
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const handleClearHistoryRequest = () => {
    setAdminAction('clearHistory');
    setAdminPassword('');
    setShowAdminModal(true);
  };

  const verifyAdminPassword = () => {
    if (adminPassword === 'admin888') {
      setShowAdminModal(false);
      setAdminPassword('');
      
      if (adminAction === 'settings') {
        setTempClassCounts(classCounts); 
        setTempSemesterStart(semesterStart);
        setTempSemesterEnd(semesterEnd);
        setTempCleaningMapImage(cleaningMapImage);
        setActiveTab('settings');
        showToast('驗證成功', 'success');
      } else if (adminAction === 'clearHistory') {
        setModalConfig({
          isOpen: true,
          type: 'delete',
          title: '清空所有資料',
          message: '警告：這將刪除資料庫中「所有」的整潔評分資料，此操作無法復原！確定要執行嗎？',
          onConfirm: executeClearHistory
        });
      }
    } else {
      showToast('密碼錯誤', 'error');
    }
  };

  const executeClearHistory = async () => {
    closeModal();
    setSubmitting(true);
    try {
      const q = collection(db, 'artifacts', appId, 'public', 'data', COLLECTION_NAME);
      const snapshot = await getDocs(q);
      
      const batches = [];
      let batch = writeBatch(db);
      let operationCounter = 0;
      
      snapshot.docs.forEach((documentSnap) => {
          batch.delete(documentSnap.ref);
          operationCounter++;
          if (operationCounter >= 490) { 
              batches.push(batch.commit());
              batch = writeBatch(db);
              operationCounter = 0;
          }
      });
      if (operationCounter > 0) batches.push(batch.commit());
      
      await Promise.all(batches);
      showToast("所有紀錄已清空", 'success');
    } catch (e) {
      showToast(`清空失敗: ${e.message}`, 'error');
    } finally {
      setSubmitting(false);
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
      const payload = {
        classCounts: tempClassCounts,
        semesterStart: tempSemesterStart,
        semesterEnd: tempSemesterEnd,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      };
      
      // 如果有圖片，則存入 Payload
      if (tempCleaningMapImage) {
          payload.cleaningMapImage = tempCleaningMapImage;
      } else {
          payload.cleaningMapImage = null;
      }

      await setDoc(docRef, payload);
      
      setClassCounts(tempClassCounts);
      setSemesterStart(tempSemesterStart);
      setSemesterEnd(tempSemesterEnd);
      setCleaningMapImage(tempCleaningMapImage);
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
               <button key={v} onClick={() => handleScoreChange(classId, v)}
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center
                   ${score === v ? 'bg-red-500 text-white shadow-md scale-110 z-10' : 'text-red-400 hover:bg-red-100 bg-white border border-slate-100'}`}
               >{v}</button>
             ))}
             <button onClick={() => handleScoreChange(classId, 0)}
               className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center mx-1
                 ${score === 0 ? 'bg-slate-500 text-white shadow-md scale-110 z-10' : 'text-slate-400 hover:bg-slate-200 bg-white border border-slate-100'}`}
             >0</button>
             {[1, 2, 3].map(v => (
               <button key={v} onClick={() => handleScoreChange(classId, v)}
                 className={`w-9 h-9 sm:w-10 sm:h-10 rounded font-bold text-sm transition-all flex items-center justify-center
                   ${score === v ? (selectedType === 'classroom' ? 'bg-blue-500 text-white shadow-md scale-110' : 'bg-emerald-500 text-white shadow-md scale-110') 
                     : (selectedType === 'classroom' ? 'text-blue-500 hover:bg-blue-100 bg-white border border-slate-100' : 'text-emerald-500 hover:bg-emerald-100 bg-white border border-slate-100')}`}
               >+{v}</button>
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

  const semesterPrintHistory = (semesterHistory || []).filter(h => {
    const relWeek = getRelativeWeekNumber(h.week, semesterStart);
    return relWeek !== null && relWeek > 0;
  });

  return (
    <>
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 relative print-hide">
      
      {/* Map Modal */}
      {showMapModal && (
        <div className="fixed inset-0 bg-slate-900/90 z-[60] flex flex-col items-center justify-center p-4 animate-fade-in backdrop-blur-sm">
          <div className="flex justify-between w-full max-w-4xl mb-4 items-center">
            <h3 className="text-white font-bold text-xl flex items-center gap-2"><Map /> 掃區分配圖</h3>
            <button onClick={() => setShowMapModal(false)} className="text-white hover:bg-white/20 p-2 rounded-full transition-colors"><X size={24}/></button>
          </div>
          <div className="w-full max-w-4xl bg-slate-800 rounded-xl overflow-hidden flex items-center justify-center min-h-[50vh] relative shadow-2xl border border-slate-700 p-2">
            {cleaningMapImage ? (
              <img src={cleaningMapImage} alt="掃區分配圖" className="max-w-full max-h-[75vh] object-contain rounded-lg" />
            ) : (
              <div className="text-slate-400 flex flex-col items-center gap-3">
                <ImageIcon size={48} className="opacity-50" />
                <p className="font-bold">尚未設定掃區分配圖</p>
                <p className="text-sm">請先進入「設定」頁面上傳圖檔</p>
              </div>
            )}
          </div>
        </div>
      )}

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
                <input type="password" autoFocus value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && verifyAdminPassword()} className="w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-800 outline-none font-bold tracking-widest text-lg" placeholder="Password"/>
              </div>
            </div>
            <div className="p-4 bg-slate-50 flex gap-3">
              <button onClick={() => { setShowAdminModal(false); setAdminPassword(''); }} className="flex-1 py-2 text-slate-500 font-bold hover:bg-slate-200 rounded-lg transition-colors">取消</button>
              <button onClick={verifyAdminPassword} className="flex-1 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-black transition-colors">確認</button>
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
            <div className="p-6"><p className="text-slate-600 font-medium">{modalConfig.message}</p></div>
            <div className="p-4 bg-slate-50 flex gap-3">
              <button onClick={closeModal} className="flex-1 py-2.5 text-slate-500 font-bold hover:bg-slate-200 rounded-lg transition-colors">取消</button>
              <button onClick={modalConfig.onConfirm} className={`flex-1 py-2.5 text-white font-bold rounded-lg shadow-lg transition-transform active:scale-95 ${modalConfig.type === 'delete' ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>確定</button>
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
          <button onClick={() => setActiveTab('score')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'score' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}><ClipboardList size={18} /> 評分</button>
          <button onClick={() => setActiveTab('ranking')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'ranking' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}><Trophy size={18} /> 榮譽榜</button>
          <button onClick={() => setActiveTab('history')} className={`flex-1 py-3 px-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'history' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}><BarChart3 size={18} /> 紀錄</button>
          <button onClick={handleSettingsClick} className={`flex-0 py-3 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${activeTab === 'settings' ? 'bg-slate-700 text-white shadow-md' : 'text-slate-400 hover:bg-slate-50'}`}><Settings size={18} /> 設定</button>
        </div>

        {/* SCORING TAB */}
        {activeTab === 'score' && (
          <div className="animate-fade-in">
            {/* 查看地圖按鈕 */}
            <button onClick={() => setShowMapModal(true)} className="w-full mb-4 py-3 px-4 bg-emerald-50 text-emerald-700 rounded-xl border border-emerald-200 font-bold flex items-center justify-center gap-2 hover:bg-emerald-100 transition-colors shadow-sm">
               <Map size={18} /> 查看各班掃區分配圖
            </button>

            <div className="grid grid-cols-2 gap-3 mb-4">
               {SCORE_TYPES.map(type => {
                 const Icon = type.icon;
                 const isActive = selectedType === type.id;
                 return (
                   <button key={type.id} onClick={() => setSelectedType(type.id)}
                     className={`p-4 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-2 ${isActive ? `border-${type.color.split('-')[1]} ${type.bg} ${type.color}` : 'border-slate-100 bg-white text-slate-400 hover:bg-slate-50'}`}>
                     <Icon size={24} strokeWidth={isActive ? 2.5 : 2}/><span className="font-bold">{type.label}</span>
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
                    <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm font-bold"/>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-400 mb-2 uppercase">選擇年級</label>
                <div className="flex gap-2">
                  {GRADES.map(g => {
                    const hasUnsaved = Object.keys(currentScores).some(classId => classId.startsWith(String(g)));
                    return (
                      <button key={g} onClick={() => setSelectedGrade(g)} className={`flex-1 py-2 rounded-lg font-bold text-sm transition-all relative ${selectedGrade === g ? 'bg-slate-800 text-white shadow-md ring-2 ring-offset-2 ring-slate-800' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                        {g} 年級
                        {hasUnsaved && (
                          <span className="absolute -top-1 -right-1 flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span></span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-3 mb-6">
              {getClassesList(selectedGrade, classCounts).map(classId => (
                <ClassScoreRow key={classId} classId={classId} stats={currentWeekStats[classId] || {}} />
              ))}
            </div>

            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-20">
              <label className="block text-xs font-bold text-slate-400 mb-2 uppercase flex items-center gap-1">
                <MessageSquare size={14} /> 反映事項 (選填)
              </label>
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="有什麼突發狀況或備註事項嗎？請在此輸入..." className="w-full p-3 border border-slate-200 rounded-lg bg-slate-50 focus:border-emerald-500 outline-none text-sm min-h-[80px]"/>
            </div>

            <div className="fixed bottom-6 left-0 right-0 px-4 z-30 max-w-3xl mx-auto">
              <button onClick={handleConfirmSubmit} disabled={submitting} className={`w-full text-white py-4 rounded-xl shadow-xl font-bold text-lg flex items-center justify-center gap-2 active:scale-95 transition-transform disabled:opacity-70 disabled:scale-100 ${selectedType === 'classroom' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                {submitting ? <span>儲存中...</span> : <><Save size={20} /> {Object.keys(currentScores).length > 0 ? `儲存 ${Object.keys(currentScores).length} 筆評分` : `儲存【${getTypeName(selectedType)}】評分`}</>}
              </button>
            </div>
          </div>
        )}

        {/* RANKING TAB */}
        {activeTab === 'ranking' && (
          <div className="animate-fade-in space-y-6">
            <div className="relative flex items-center justify-center bg-white p-4 rounded-xl shadow-sm border border-slate-200">
              <button onClick={() => changeWeek(-1)} className="absolute left-4 p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronLeft size={20}/></button>
              
              <div className="text-center flex flex-col items-center">
                <div className="bg-slate-100 text-slate-500 text-[10px] sm:text-xs font-bold px-3 py-1 rounded-full mb-2">
                  本週是 {realCurrentWeekLabel}
                </div>
                <div className="text-sm font-bold text-slate-500">你檢視的是</div>
                <div className="text-2xl font-black text-emerald-900 mt-1">{currentWeekLabel}</div>
                <div className="text-xs text-emerald-600 font-bold mt-1">(教室 + 外掃 總積分)</div>
              </div>
              
              <div className="absolute right-4 flex gap-2">
                 <button onClick={() => window.print()} className="p-2 bg-emerald-50 rounded-full hover:bg-emerald-100 text-emerald-600 transition-colors" title="列印報表"><Printer size={20}/></button>
                 <button onClick={() => changeWeek(1)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><ChevronRight size={20}/></button>
              </div>
            </div>

            {GRADES.map(grade => {
              const data = weeklyRankings[grade] || [];
              const top1 = data[0];
              const top2 = data[1];
              
              const isThreeWeekWinner = top1 && threeWeekWinners.includes(top1.classId);

              return (
                <div key={grade} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                  <div className="bg-slate-50 p-3 border-b border-slate-100 flex justify-between items-center">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><span className="bg-emerald-600 text-white text-xs px-2 py-0.5 rounded">{grade} 年級</span> 總排行榜</h3>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 p-4 bg-gradient-to-b from-white to-slate-50">
                    {/* Winner */}
                    <div className="flex flex-col items-center relative mt-4">
                      <Trophy className="text-yellow-400 drop-shadow-sm absolute -top-6 z-20" size={32} fill="currentColor"/>
                      <div className="w-full bg-yellow-50 border-2 border-yellow-200 rounded-xl p-4 text-center shadow-sm relative z-10 mt-1">
                        {isThreeWeekWinner && (
                          <div className="absolute -top-3.5 left-1/2 transform -translate-x-1/2 bg-red-600 text-white text-[10px] font-black px-3 py-1 rounded-full shadow-lg whitespace-nowrap animate-bounce tracking-widest border border-red-400 z-30">
                            連續三週第一名
                          </div>
                        )}
                        <div className="text-xs font-bold text-yellow-600 uppercase mb-1">第一名</div>
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

        {/* HISTORY TAB */}
        {activeTab === 'history' && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
               <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-800">最新評分紀錄</h3>
                    <span className="text-xs bg-white border border-slate-200 text-slate-500 px-2 py-1 rounded">最近 300 筆</span>
                  </div>
                  <button onClick={handleClearHistoryRequest} className="flex items-center gap-1 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 px-3 py-1.5 rounded transition-colors"><Trash2 size={14} /> 全部清除</button>
               </div>
               <div className="max-h-[60vh] overflow-y-auto">
                 <table className="w-full text-sm">
                   <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 shadow-sm z-10">
                     <tr><th className="p-3 text-left">班級/日期</th><th className="p-3 text-left">類別</th><th className="p-3 text-right">分數</th><th className="p-3 w-10"></th></tr>
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
                            <span className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 w-fit ${record.type === 'classroom' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
                              {record.type === 'classroom' ? <Home size={10}/> : <Trees size={10}/>} {getTypeName(record.type)}
                            </span>
                            {record.note && (
                              <div className="text-[10px] text-slate-500 flex items-start gap-1 max-w-[120px] leading-tight mt-1 bg-slate-100 p-1 rounded">
                                <MessageSquare size={10} className="mt-0.5 shrink-0" /><span className="truncate">{record.note}</span>
                              </div>
                            )}
                           </div>
                         </td>
                         <td className="p-3 text-right">
                           <span className={`font-bold ${record.score > 0 ? 'text-emerald-600' : (record.score < 0 ? 'text-red-600' : 'text-slate-400')}`}>{record.score > 0 ? '+' : ''}{record.score}</span>
                         </td>
                         <td className="p-3 text-center"><button onClick={() => handleConfirmDelete(record.id)} className="text-slate-300 hover:text-red-500 transition-colors"><Trash2 size={16} /></button></td>
                       </tr>
                     ))}
                     {scoresData.length === 0 && <tr><td colSpan="4" className="p-8 text-center text-slate-400">無歷史資料</td></tr>}
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
             <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-8">
                
                {/* 班級數量設定 */}
                <div>
                  <div className="border-b border-slate-100 pb-4 mb-4">
                    <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                      <Settings className="text-slate-500" /> 班級數量設定
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">調整每個年級的班級總數，設定將即時套用到所有使用者的介面。</p>
                  </div>
                  <div className="grid gap-4">
                    {GRADES.map(grade => (
                      <div key={grade} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-100">
                        <div>
                          <div className="font-bold text-slate-700 text-lg">{grade} 年級</div>
                          <div className="text-xs text-slate-400">目前的範圍: {grade}01 - {grade}{String(tempClassCounts[grade]).padStart(2, '0')}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button onClick={() => handleSettingsChange(grade, tempClassCounts[grade] - 1)} className="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-100 flex items-center justify-center font-bold text-xl">-</button>
                          <div className="w-12 text-center font-black text-2xl text-emerald-600">{tempClassCounts[grade]}</div>
                          <button onClick={() => handleSettingsChange(grade, tempClassCounts[grade] + 1)} className="w-10 h-10 rounded-full bg-white border border-slate-200 text-emerald-600 hover:bg-emerald-50 flex items-center justify-center font-bold text-xl">+</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 掃區分配圖設定 */}
                <div>
                  <div className="border-b border-slate-100 pb-4 mb-4">
                    <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                      <Map className="text-slate-500" /> 掃區分配圖設定
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">上傳學校的掃區分配圖，方便老師在評分時對照。圖片會自動進行壓縮以節省空間。</p>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-lg border border-slate-100">
                    {tempCleaningMapImage && (
                      <div className="mb-4 relative rounded-lg border border-slate-200 overflow-hidden bg-white flex justify-center p-2">
                        <img src={tempCleaningMapImage} alt="預覽" className="max-h-60 object-contain" />
                        <button onClick={() => setTempCleaningMapImage(null)} className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 shadow"><Trash2 size={16}/></button>
                      </div>
                    )}
                    <div className="flex items-center justify-center w-full">
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-slate-300 border-dashed rounded-lg cursor-pointer bg-white hover:bg-slate-50 transition-colors">
                            <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                <Upload className="w-8 h-8 mb-3 text-slate-400" />
                                <p className="mb-2 text-sm text-slate-500 font-bold">點擊上傳圖檔</p>
                                <p className="text-xs text-slate-400">支援 JPG, PNG 格式 (自動壓縮)</p>
                            </div>
                            <input type="file" className="hidden" accept="image/png, image/jpeg" onChange={handleImageUpload} />
                        </label>
                    </div>
                  </div>
                </div>

                {/* 學期日期設定 */}
                <div>
                  <div className="border-b border-slate-100 pb-4 mb-4">
                    <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                      <Calendar className="text-slate-500" /> 學期日期設定
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">設定本學期的開始與結束日期，榮譽榜將自動以「開學當週」為第 1 週開始計算。</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2 p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <label className="font-bold text-slate-700 text-sm">學期開始日期</label>
                      <input type="date" value={tempSemesterStart} onChange={(e) => setTempSemesterStart(e.target.value)} className="p-3 border border-slate-200 rounded-lg focus:border-emerald-500 outline-none font-bold text-slate-600"/>
                    </div>
                    <div className="flex flex-col gap-2 p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <label className="font-bold text-slate-700 text-sm">學期結束日期</label>
                      <input type="date" value={tempSemesterEnd} onChange={(e) => setTempSemesterEnd(e.target.value)} className="p-3 border border-slate-200 rounded-lg focus:border-emerald-500 outline-none font-bold text-slate-600"/>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100">
                  <button onClick={saveSettings} disabled={isSavingSettings} className="w-full bg-slate-800 text-white py-4 rounded-xl font-bold text-lg hover:bg-black transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                    {isSavingSettings ? '儲存設定中...' : <><Save size={20} /> 儲存變更</>}
                  </button>
                </div>
             </div>
          </div>
        )}
      </main>
    </div>

    {/* --- 列印專用版面 (在網頁上隱藏，列印時顯示) --- */}
    <style dangerouslySetInnerHTML={{__html: `
      @media print {
        body { background: white !important; }
        .print-hide { display: none !important; }
        .print-show { display: block !important; }
      }
      @media screen {
        .print-show { display: none !important; }
      }
    `}} />

    <div className="print-show bg-white p-8 text-black font-sans w-full max-w-none m-0">
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
            
            const isThreeWeekWinner = top1 !== '-' && threeWeekWinners.includes(top1);

            return (
              <tr key={g}>
                <td className="border border-black p-3 font-bold">{g} 年級</td>
                <td className="border border-black p-3 font-black text-2xl">
                  <span className="align-middle">{top1}</span>
                  {isThreeWeekWinner && (
                    <span className="text-sm font-bold text-black border-2 border-black ml-3 px-2 py-0.5 rounded align-middle whitespace-nowrap tracking-wider inline-block">
                      [連續三週第一名]
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
      <table className="w-full border-collapse border border-black text-center text-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="border border-black p-2 font-bold w-1/4">週次</th>
            <th className="border border-black p-2 font-bold w-1/4">一年級</th>
            <th className="border border-black p-2 font-bold w-1/4">二年級</th>
            <th className="border border-black p-2 font-bold w-1/4">三年級</th>
          </tr>
        </thead>
        <tbody>
          {semesterPrintHistory.map(h => {
             const relW = getRelativeWeekNumber(h.week, semesterStart);
             return (
               <tr key={h.week}>
                 <td className="border border-black p-2 font-bold bg-gray-50">第 {relW} 週</td>
                 {GRADES.map(g => {
                   const t1 = h.rankings[g]?.[0]?.classId || '-';
                   const t2 = h.rankings[g]?.[1]?.classId || '-';
                   return (
                     <td key={g} className="border border-black p-2">
                       <span className="font-bold text-base">{t1}</span>
                       <span className="text-gray-400 mx-2">/</span>
                       <span className="text-gray-600">{t2}</span>
                     </td>
                   )
                 })}
               </tr>
             )
          })}
          {semesterPrintHistory.length === 0 && (
             <tr><td colSpan="4" className="border border-black p-4 text-gray-500 italic">尚無本學期紀錄</td></tr>
          )}
        </tbody>
      </table>
      
      <div className="mt-8 text-right text-xs text-gray-500">
        列印時間：{new Date().toLocaleString('zh-TW')}
      </div>
    </div>
    </>
  );
};

export default App;