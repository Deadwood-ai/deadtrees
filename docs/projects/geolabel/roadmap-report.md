# GeoLabel: Community Label Correction System for Geospatial ML
Teja Kattenborn, Janusch Vajna-Jehle, Clemens Mosig

1 Department for Sensor-based Geoinformatics (GeoSense), University of Freiburg, Germany

Date of submission: TBD

| Pilot title | GeoLabel: Community Label Correction System |
| :---- | :---- |
| Project duration | 01-2025 to 12-2025 |
| Contributors | Teja Kattenborn (Conceptualization; Project Administration; Supervision; Writing - Review & Editing), Janusch Vajna-Jehle (Software; Writing - Original Draft), Clemens Mosig (Conceptualization; Software; Writing - Review & Editing) |
| DOI | To be reserved on Zenodo |
| Corresponding author | TBD |

This work has been funded by the German Research Foundation (NFDI4Earth, DFG project no. 460036893, https://www.nfdi4earth.de/).

## Abstract
Earth System Science depends on high-quality geospatial labels for training and validating machine learning models, yet existing labeling workflows are slow, fragmented, and difficult to apply at scale. GeoLabel addresses this gap by enabling community-driven corrections directly on model predictions with built-in auditability and quality control. The pilot delivers a public correction workflow for deadwood and forest cover predictions on deadtrees.earth, including review and revert mechanisms for safe community contributions. Over the last 12 months, the platform received 5,919 dataset submissions from 158 submitters and recorded 16,709 unique users, demonstrating strong community engagement. GeoLabel provides an operational, open-access example of how to integrate scalable labeling into a real-world workflow, with a clear path to broader adoption and continued expansion.

## I. Introduction
High-quality, geospatially explicit labels are essential for training machine learning models that support forest monitoring and Earth System Science. Traditional labeling tools are often limited to small datasets, lack geospatial context, and do not scale to the volume or diversity of data needed for robust models. GeoLabel aims to address these limitations by providing a practical, community-centered correction workflow for existing model predictions, with emphasis on scalability, auditability, and real-world usability.

The pilot focuses on enabling public, browser-based corrections to deadwood and forest cover predictions, while ensuring quality through a review process. The system is designed to be usable without local deployment and to support contributors across different institutions, data sources, and geographic regions.

## II. Results

### a) Implemented solution
GeoLabel is implemented as a public correction workflow integrated into deadtrees.earth. Users review model predictions on high-resolution orthomosaics and propose edits directly on the map. The system supports three edit operations:

- Add missing polygons
- Modify existing polygons
- Delete incorrect polygons

![Screencast: Adding a missing polygon in the GeoLabel editing workflow](assets/deadtrees-editing-feature-add-missing-polygon-short-lots-zoom.gif)
*Figure: Adding a missing deadwood polygon using the GeoLabel correction workflow.*

The correction workflow is designed around two complementary roles:

- Contributors can propose edits through an interactive editor that supports direct polygon editing and optional AI-assisted boundary suggestions.
- Auditors can review pending edits, approve or revert changes, and maintain a clear audit trail.

Key technical elements include:

- Database-generated vector tiles using PostGIS MVT functions for fast rendering of large geospatial datasets.
- A correction table that records all edits, with audit metadata and history.
- Optimistic locking and conflict detection to prevent concurrent editing issues.
- An audit workflow that allows reviewers to approve or revert edits before they are applied.

This combination provides both scalability (fast visualization of large data) and data integrity (auditability of community edits). The system ensures that edits are visible and reviewable without immediately altering the underlying data, allowing the community to contribute while preserving scientific quality.

Additional implementation highlights:

- Dual-layer support: corrections can be applied to both deadwood and forest cover prediction layers.
- Correction styling: pending and approved edits are visually distinguished to communicate review status.
- Fast refresh after edits: vector tile sources are invalidated and reloaded to avoid stale visuals.

Editing capabilities were a core focus of the pilot. The editor provides a fast, low-friction entry into editing mode and offers the following tools:

- Polygon drawing with freehand placement to add missing objects.
- AI-assisted segmentation to propose boundaries from user input.
- Cut, merge, and clip operations to refine polygon topology.
- Delete and undo actions to correct mistakes quickly.
- Inline editing without page transitions, with predictions loaded into an overlay for immediate editing.

Keyboard-first interaction is supported to reduce friction during detailed edits:

- A: draw mode
- D: delete selection
- G: merge (two polygons)
- X: clip (two polygons)
- C: cut hole (single polygon)
- S: toggle AI assist
- Ctrl/Cmd+Z: undo
- Ctrl/Cmd+S: save
- Esc: cancel editing

### b) Data and software availability
- Platform: https://deadtrees.earth
- Backend repository (public, GPL-3.0): https://github.com/Deadwood-ai/deadtrees
- Frontend repository: https://github.com/Deadwood-ai/deadtrees-frontend-react (planned for public release)
- Pilot documentation: `docs/projects/geolabel/`

The platform provides open access to datasets, prediction layers, and correction workflows. Documentation includes user guidance, technical overviews, and detailed descriptions of the correction workflow.

Core data and software assets include:

- PostGIS-backed vector tile generation for large-scale prediction layers.
- Correction history stored in a dedicated table with review metadata and session tracking.
- Supabase RPC functions that expose database logic as API endpoints for save, approve, and revert operations.

### c) Innovation and FAIRness
The key innovation is a community-first, audit-ready correction system applied directly to model outputs, rather than isolated labeling tasks. This approach supports:

- Findability and accessibility: open access to datasets and corrections via a public platform.
- Interoperability: PostGIS-based geospatial standards and APIs.
- Reusability: corrections are tracked, reviewed, and preserved with history, supporting downstream model training and validation.

GeoLabel also demonstrates a scalable approach to collaborative labeling that can be adapted to other domains in Earth System Science. By combining database-native vector tile generation with correction workflows, the system achieves a balance between high performance and strict quality control.

### b) Data and software availability
- Platform: https://deadtrees.earth
- Backend repository (public, GPL-3.0): https://github.com/Deadwood-ai/deadtrees
- Frontend repository: https://github.com/Deadwood-ai/deadtrees-frontend-react (planned for public release)
- Pilot documentation: `docs/projects/geolabel/`

The platform provides open access to datasets, prediction layers, and correction workflows. Documentation includes user guidance, technical overviews, and detailed descriptions of the correction workflow.

### c) Innovation and FAIRness
The key innovation is a community-first, audit-ready correction system applied directly to model outputs, rather than isolated labeling tasks. This approach supports:

- Findability and accessibility: open access to datasets and corrections via a public platform.
- Interoperability: PostGIS-based geospatial standards and APIs.
- Reusability: corrections are tracked, reviewed, and preserved with history, supporting downstream model training and validation.

GeoLabel also demonstrates a scalable approach to collaborative labeling that can be adapted to other domains in Earth System Science.

## III. Challenges and gaps
The main technical challenge was balancing high-performance visualization with direct, editable data access. Several iterations were required:

1) Copy-based editing (used in the reference data editor). This approach is reliable but slow for large datasets and leads to heavy data duplication.
2) Database-native vector tiles and edit workflows. The final solution generates vector tiles directly in the database and exposes PostGIS functions as API endpoints. This allows fast rendering and direct editing without full dataset copies.

Additional challenges included:

- Designing a robust audit workflow for community contributions.
- Ensuring edits remain reversible and auditable to preserve data quality.
- Optimizing caching and tile refresh to avoid stale visuals after edits.

The final system resolves these issues by combining PostGIS MVT generation with Supabase RPC functions for save/approve/revert workflows and a review queue for auditors.

## IV. Relevance for the community and NFDI4Earth
GeoLabel targets a critical bottleneck in geospatial ML: scalable, high-quality labeling that can be performed by a distributed community while remaining scientifically trustworthy. The pilot demonstrates how public participation and strong audit controls can coexist in a single workflow.

Community uptake indicators (last 12 months):

- 5,919 datasets submitted
- 158 unique submitters
- 16,709 unique users (based on distinct pageview users)

Outreach and visibility include:

- SmartForest 2025: deadtrees.earth: Crowd-Sourced Imagery and AI for Global Insights into Tree Mortality Dynamics
- Dreilaendertagung 2025: From Local Drones to Global Insights: AI-Driven Tree Mortality Mapping with Remote Sensing
- EGU 2025 sessions on tree mortality and remote sensing
- Living Planet Symposium 2025 and BioSpace 2025 presentations
- International Tree Mortality Network seminar (2024)

These activities demonstrate active engagement with the Earth System Science community and provide multiple entry points for collaboration and adoption.

## V. Future directions
GeoLabel establishes a robust public correction workflow, but there is still substantial opportunity for growth:

- Expand correction workflows to additional label types and domains.
- Improve analytical tooling around correction impact and reviewer throughput.
- Provide enriched dataset metadata and tighter linkage to publications.
- Support broader integration into external workflows and third-party systems.
- Continue outreach to grow the contributor base and diversify geographic coverage.

The pilot shows that community labeling at scale is feasible when performance, auditability, and usability are addressed together. The next steps focus on strengthening adoption, expanding feature coverage, and ensuring long-term sustainability.

## Publications and related outputs (selected)
- deadtrees.earth - An open-access and interactive database for centimeter-scale aerial imagery to uncover global tree mortality dynamics. Remote Sensing of Environment, 2026.
- Global, Multi-Scale Standing Deadwood Segmentation in Centimeter-Scale Aerial Images. ISPRS Open Journal of Photogrammetry and Remote Sensing, 2025.

## Figures and screenshots
Figure placeholders to be added in the final version:
- Figure 1: Correction workflow overview (user edit -> audit -> approval)
- Figure 2: Example correction before/after
- Figure 3: System architecture (frontend, database, PostGIS tile generation)
