const strategies = {
  restaurant: {
    tone: "experience",
    emotions: ["ריח", "טעם", "אווירה", "חוויה"],
    approach: "כתוב חוויית חושים. גרום לקורא להרגיש את הריח, הטעם, האווירה.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  food_product: {
    tone: "taste",
    emotions: ["טעם", "איכות", "תענוג", "בריאות"],
    approach: "כתוב על הטעם, האיכות והתענוג שבמוצר.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  pet: {
    tone: "emotion",
    emotions: ["אהבה", "משפחה", "חיבור", "טיפול"],
    approach: "כתוב רגש. חיבור, אהבה, משפחתיות.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  gaming: {
    tone: "performance",
    emotions: ["דיוק", "שליטה", "ביצועים", "ניצחון"],
    approach: "כתוב ביצועים ושליטה. דיוק, מהירות, יתרון.",
    forbidden: ["הדור הבא", "מהפכה", "ההבדל בין ניצחון לתבוסה"]
  },
  cosmetics: {
    tone: "confidence",
    emotions: ["ביטחון", "יופי", "שינוי", "תחושה"],
    approach: "כתוב ביטחון עצמי. תחושה, שינוי, גילוי.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  professional_service: {
    tone: "trust",
    emotions: ["אמינות", "מקצועיות", "תוצאות", "שקט נפשי"],
    approach: "כתוב אמינות ותוצאות. ניסיון, מקצועיות, שקט נפשי.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  vehicle: {
    tone: "luxury",
    emotions: ["חופש", "איכות", "יוקרה", "תחושת נהיגה"],
    approach: "כתוב חופש ואיכות. נסיעה, תחושה, יוקרה.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  judaica: {
    tone: "emotion",
    emotions: ["מסורת", "רגש", "משמעות", "מתנה"],
    approach: "כתוב חיבור רגשי ומסורת. רגש, מתנה, משמעות.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  sports: {
    tone: "energy",
    emotions: ["אנרגיה", "אתגר", "תנועה", "חופש"],
    approach: "כתוב אנרגיה ואתגר. תנועה, חופש, ביצועים.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  children: {
    tone: "parental",
    emotions: ["בטיחות", "התפתחות", "חיוך", "כיף"],
    approach: "כתוב להורים. בטיחות, התפתחות, חיוך.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  fashion: {
    tone: "style",
    emotions: ["סטייל", "ביטחון", "אופנה", "ייחודיות"],
    approach: "כתוב על סטייל וביטחון עצמי. תחושת ייחודיות ואופנה.",
    forbidden: ["הדור הבא", "מהפכה"]
  },
  general: {
    tone: "engaging",
    emotions: ["איכות", "ערך", "חוויה"],
    approach: "כתוב פוסט שיווקי חי ומעניין שמדבר אל הלקוח.",
    forbidden: ["הדור הבא", "מהפכה"]
  }
};

module.exports = strategies;