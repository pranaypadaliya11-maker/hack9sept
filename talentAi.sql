erDiagram
    USERS {
        uuid id PK
        string email
        string password_hash
        string role "athlete | coach"
        timestamp created_at
    }

    ATHLETES {
        uuid id PK
        uuid user_id FK
        string name
        int age
        string gender
        float height_cm
        float weight_kg
        string location
        string[] preferred_sports
        string experience_level
        string training_freq
    }

    EXERCISES {
        uuid id PK
        string name
        string category
        text instructions
        string[] target_muscles
        string rule_set_version
    }

    VIDEOS {
        uuid id PK
        uuid athlete_id FK
        uuid exercise_id FK
        string storage_url "NULLABLE"
        boolean consent_given
        boolean processed_locally
        timestamp created_at
        timestamp deleted_at
    }

    POSE_RESULTS {
        uuid id PK
        uuid video_id FK
        int frame_index
        jsonb landmarks
        jsonb joint_angles
    }

    ASSESSMENTS {
        uuid id PK
        uuid athlete_id FK
        uuid exercise_id FK
        uuid video_id FK
        int total_reps
        int correct_reps
        int incorrect_reps
        float form_score
        float stability_score
        float rom_score
        float tempo_score
        float consistency_score
        float overall_score
        jsonb mistakes
        timestamp created_at
    }

    FITNESS_METRICS {
        uuid id PK
        uuid athlete_id FK
        float strength
        float speed
        float agility
        float endurance
        float flexibility
        float balance
        float coordination
        float explosiveness
        float overall_athletic_score
        timestamp computed_at
    }

    SPORTS {
        uuid id PK
        string name
        jsonb required_attributes
    }

    RECOMMENDATIONS {
        uuid id PK
        uuid athlete_id FK
        uuid sport_id FK
        float match_pct
        jsonb rationale
        timestamp created_at
    }

    PROGRESS_SNAPSHOTS {
        uuid id PK
        uuid athlete_id FK
        string metric_name
        float value
        timestamp recorded_at
    }

    ACHIEVEMENTS {
        uuid id PK
        uuid athlete_id FK
        string badge_code
        timestamp earned_at
    }

    COACHES {
        uuid id PK
        uuid user_id FK
        string organization
        boolean verified
    }

    USERS ||--o{ ATHLETES : "has profile"
    USERS ||--o{ COACHES : "has profile"
    ATHLETES ||--o{ VIDEOS : "uploads"
    EXERCISES ||--o{ VIDEOS : "evaluated in"
    VIDEOS ||--o{ POSE_RESULTS : "generates stream"
    VIDEOS ||--o| ASSESSMENTS : "results in"
    ATHLETES ||--o{ ASSESSMENTS : "performs"
    ATHLETES ||--o{ FITNESS_METRICS : "tracks"
    ATHLETES ||--o{ RECOMMENDATIONS : "receives"
    SPORTS ||--o{ RECOMMENDATIONS : "matches"
    ATHLETES ||--o{ PROGRESS_SNAPSHOTS : "logs"
    ATHLETES ||--o{ ACHIEVEMENTS : "earns"