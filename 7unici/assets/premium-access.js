import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDIS8wAIqjSfLaUurqiF2kJe6mcEQLuz8w",
  authDomain: "sameerswaraj-15d99.firebaseapp.com",
  databaseURL: "https://sameerswaraj-15d99-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sameerswaraj-15d99",
  storageBucket: "sameerswaraj-15d99.firebasestorage.app",
  messagingSenderId: "1041213217954",
  appId: "1:1041213217954:web:810f484ecb32148aac4bfb",
  measurementId: "G-KLS7W2RRSK"
};

const app = getApps().find((item) => item.options?.projectId === firebaseConfig.projectId) || initializeApp(firebaseConfig, "premiumGuard");
const auth = getAuth(app);
const db = getDatabase(app);

const unlockedPages = new Set(["auth.html", "premium.html"]);
const currentPage = location.pathname.split("/").pop() || "index.html";

function currentDestination() {
  return currentPage + location.search + location.hash;
}

function isPaymentActive(payment = {}) {
  if (payment.lifetime === true && payment.status === "active") return true;
  return payment.status === "active" && ["monthly", "yearly"].includes(payment.plan);
}

function redirectToLogin() {
  const destination = currentDestination();
  localStorage.setItem("loginRedirect", destination);
  location.replace("auth.html?redirect=" + encodeURIComponent(destination));
}

function redirectToPremium() {
  const destination = currentDestination();
  localStorage.setItem("paymentRedirect", destination);
  location.replace("premium.html?redirect=" + encodeURIComponent(destination));
}

if (!unlockedPages.has(currentPage)) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      redirectToLogin();
      return;
    }

    try {
      const snapshot = await get(ref(db, `users/${user.uid}/payment`));
      if (!isPaymentActive(snapshot.exists() ? snapshot.val() : {})) {
        redirectToPremium();
      }
    } catch (error) {
      console.warn("Premium access check failed:", error);
      redirectToPremium();
    }
  });
}
