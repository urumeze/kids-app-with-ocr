// routes/wallet.js
router.post("/convertPointsToGQ", verifyIdToken, async (req, res) => {
  const { amountToConvert } = req.body; // e.g., 200
  const uid = req.user.uid;

  if (!amountToConvert || amountToConvert < 100) {
    return res.status(400).json({ success: false, error: "Minimum 100 points required." });
  }

  const userRef = firestore.collection("users").doc(uid);

  try {
    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found.");

      const currentPoints = userDoc.data().coinBalance || 0;
      const currentGQ = userDoc.data().gqBalance || 0;

      if (currentPoints < amountToConvert) {
        throw new Error("Insufficient points.");
      }

      // Enforce server-side conversion rates
      const gqGained = Math.floor(amountToConvert / 100);
      const pointsDeducted = gqGained * 100;

      const newPoints = currentPoints - pointsDeducted;
      const newGQ = currentGQ + gqGained;

      t.update(userRef, { 
        coinBalance: newPoints, 
        gqBalance: newGQ,
        lastConversionAt: Timestamp.now() 
      });

      return { newPoints, newGQ };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});


// NEW: Secure Backend Conversion
router.post("/convertCurrency", verifyIdToken, async (req, res) => {
  const { from, to, amount } = req.body;
  const uid = req.user.uid;

  try {
    const userRef = firestore.collection("users").doc(uid);

    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");

      const data = userDoc.data();
      let currentPoints = data.coinBalance || 0;
      let currentGQ = data.gqBalance || 0;

      if (from === "points" && to === "gq") {
        if (currentPoints < 100) throw new Error("Need at least 100 points.");
        const pointsToUse = Math.floor(amount / 100) * 100; // Only convert chunks of 100
        const gqEarned = pointsToUse / 100;
        
        t.update(userRef, { 
          coinBalance: currentPoints - pointsToUse,
          gqBalance: currentGQ + gqEarned 
        });
      } 
      else if (from === "gq" && to === "points") {
        if (currentGQ < amount) throw new Error("Insufficient GQ.");
        t.update(userRef, { 
          gqBalance: currentGQ - amount,
          coinBalance: currentPoints + (amount * 100)
        });
      }

      return { success: true };
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
