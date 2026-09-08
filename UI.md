# Fettle - UI/UX Screen Designs (Phase 1)
**SIH Problem Statement:** ID 26196 (AICTE - Fitness & Sports)
**Current Status:** Phase 1 (Focus on reliable live squat assessment)

---

## Screen 1: Dashboard & Setup
*The entry point for the user to start their assessment.*

*   **Top Navigation Bar:**
    *   App Logo ("TalentTrack") on the left.
    *   User Profile Icon (links to history/settings) on the right.
*   **Main Content Area:**
    *   **Welcome Message:** "Ready to train? Let's check your form."
    *   **Exercise Selection Grid:**
        *   **Squat Assessment** (Active / Highlighted - *Phase 1 Focus*)
        *   Push-up Assessment (Greyed out / "Phase 2")
        *   Lunge Assessment (Greyed out / "Phase 2")
    *   **Main Call-to-Action (CTA):** Large, prominent "Start Camera" button.
*   **Permissions Prompt (Hidden until CTA clicked):** 
    *   Browser pop-up/banner: "TalentTrack needs access to your camera to analyze your form privately on your device."

---

## Screen 2: Live Camera Assessment Interface
*The core functional screen where AI browser-based pose estimation runs.*

*   **Background:** Large, centralized container showing the live, mirrored webcam feed.
*   **Visual Overlay:**
    *   **Pose Skeleton:** Dynamic lines and nodes mapping the user's shoulders, hips, knees, and ankles in real-time.
    *   **Target Guides (Optional):** Subtle horizontal lines indicating required squat depth.
*   **Heads-Up Display (HUD):**
    *   **Top-Left:** Real-time Repetition Counter (Large, high-contrast font, e.g., "Reps: 0").
    *   **Top-Right:** "End Session" button (Red outline, easily clickable).
*   **Dynamic Feedback Banner (Bottom Center):**
    *   A prominent, color-coded alert box providing instant, explainable feedback based on joint angles.
    *   *State Examples:*
        *   🟩 **Green:** "Great form! Keep it up."
        *   🟨 **Yellow:** "Squat lower." / "Keep your chest up."
        *   🟥 **Red:** "Knee collapse detected - adjust stance."

---

## Screen 3: Post-Workout Analytics
*The review screen shown immediately after ending the workout to save progress.*

*   **Header:** "Workout Complete" with a timestamp and total session duration.
*   **Summary Cards (Top Row):**
    *   **Total Reps Completed:** (e.g., 15)
    *   **Form Accuracy Score:** (e.g., 85%)
*   **Detailed AI Feedback Section:**
    *   A breakdown of specific form corrections noted during the session.
    *   *Bullet points:* 
        *   "12 perfect reps."
        *   "3 reps had shallow depth."
        *   "Good torso alignment maintained throughout the set."
*   **Bottom Actions:**
    *   "Save Progress & Return Home" (Primary CTA - saves to SQLite database).
    *   "Discard Session" (Secondary CTA).
