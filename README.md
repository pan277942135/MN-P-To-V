# Zaojing Director Console

## AI Production System for AI Content Creation

`MN-P-To-V` is the source repository for **Zaojing Director Console**, an AI-native content production system for creating long-form AI videos, AI animation, and storytelling content.

The project has evolved from an image-to-video experiment into a complete AI production workflow platform.

---

# Vision

Traditional AI generation tools focus on producing isolated images or videos.

Zaojing Director Console focuses on the complete production process:

```
Creative Idea
    ↓
Script
    ↓
Storyboard
    ↓
Shot Management
    ↓
Keyframe Production
    ↓
Video Blueprint
    ↓
Video Generation
    ↓
Editing / Publishing
```

The goal is to build an AI director workstation where:

- AI assists creation
- Humans control creative decisions
- Production assets remain structured and traceable

---

# Core Production Model

The core production unit is not Episode.

The core unit is:

## Shot

Every Shot maintains its own production lifecycle:

```
Shot
 ├── Story
 ├── Storyboard
 ├── Keyframe Blueprint
 ├── Keyframe Asset
 ├── Human Review
 ├── Video Blueprint
 ├── Video Asset
 └── Production Status
```

Shots can progress independently.

Example:

```
Shot 01
Keyframe approved → Video production

Shot 02
Storyboard revision

Shot 03
Image generation
```

---

# Product Principles

## Human Director Control

AI generates suggestions and production assets.

Humans decide:

- Story direction
- Visual style
- Character consistency
- Final approval

## Shot-centric Workflow

Production is non-linear.

Adding or modifying one Shot should not destroy unrelated completed work.

Stable `shot.uid` is the permanent identity of production assets.

## Cloud Native

Production data belongs to the cloud.

Source of Truth:

- Firestore: structured production data
- Google Cloud Storage: image/video assets

---

# Architecture

```
React Director Console
          |
          v
Cloud Run Backend
          |
   +------+------+
   |             |
Firestore       GCS
(metadata)   (media assets)
```

---

# AI Stack

## Storyboard Generation

- Vertex AI Gemini
- Structured JSON Shot List output
- Server-side authentication
- No browser API key exposure

## Video Generation

Designed for integration with:

- Veo
- AI video generation pipelines

---

# Current Features

## Script & Storyboard

- Creative input
- Gemini-powered storyboard generation
- JSON structured Shot List

## Shot Management

- Create Shot
- Insert Shot before/after existing Shot
- Reorder Shot
- Stable Shot UID tracking

## Keyframe Production

- Keyframe Blueprint generation
- Image asset management
- AI image generation integration
- Human approval workflow

## Video Preparation

- Video Blueprint
- Motion description
- Camera movement
- Duration planning
- Generation prompts

## Cloud Persistence

- Firestore persistence
- Google Cloud Storage assets
- Cloud Run deployment

---

# Data Model

```
Project
  └── Episode
       └── Shot
            ├── Storyboard
            ├── Keyframe Blueprint
            ├── Keyframe Asset
            ├── Video Blueprint
            ├── Video Asset
            └── Status
```

---

# Validation Project

The first production validation project is:

## 《风从那年教室吹过》系列

This project validates the complete AI production workflow:

- Script
- Storyboard
- Shot management
- Character consistency
- Keyframe production
- Video workflow

The purpose is not only producing one animation, but proving a reusable AI content production system.

---

# Development Status

Completed:

- Gemini storyboard pipeline
- Shot-centric workflow
- Shot insertion and ordering
- Keyframe Blueprint
- Image asset workflow
- Video Blueprint
- Firestore/GCS persistence
- Cloud Run deployment

Next:

- Project Binding / Cross-device restore
- Video generation pipeline
- Editing workflow
- Publishing workflow

---

# Development Rules

1. GitHub main branch is the source of truth.
2. Cloud Run deployments must map to Git commits.
3. Shot UID is the permanent identity.
4. Order numbers can change.
5. Cloud data is the production source of truth.
6. AI assists creators; humans approve final outputs.

---

# Repository

GitHub:

https://github.com/pan277942135/MN-P-To-V

Cloud Runtime:

`zaojing-director-console-uat`

