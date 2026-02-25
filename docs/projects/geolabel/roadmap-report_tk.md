# GeoLabel: Community Label Correction System for Geospatial ML
Teja Kattenborn<sup>1</sup>, Janusch Vajna-Jehle<sup>1</sup>, Clemens Mosig<sup>2</sup>

1 Chair of Sensor-based Geoinformatics (GeoSense), University of Freiburg, Germany
2 Institute for Earth System Science and Remote Sensing, Leipzig University, Germany

Date of submission: TBD

| Pilot title | GeoLabel: Community Label Correction System |
| :---- | :---- |
| Project duration | 01-2025 to 12-2025 |
| Contributors | Teja Kattenborn (Conceptualization; Project Administration; Supervision; Writing - Review & Editing), Janusch Vajna-Jehle (Software; Writing - Original Draft), Clemens Mosig (Conceptualization; Writing - Review & Editing) |
| DOI | To be reserved on Zenodo |
| Corresponding author | TBD |

This work has been funded by the German Research Foundation via NFDI4Earth (DFG project no. 460036893, https://www.nfdi4earth.de/).

## Abstract
<!-- Old Version: Earth System Science depends on high-quality geospatial labels for training and validating machine learning models, yet existing labeling workflows are slow, fragmented, and difficult to apply at scale. GeoLabel addresses this gap by enabling community-driven corrections directly on model predictions with built-in auditability and quality control. The pilot delivers a public correction workflow for deadwood and forest cover predictions on deadtrees.earth, including review and revert mechanisms for safe community contributions. Over the last 12 months, the platform received 5,919 dataset submissions from 158 submitters and recorded 16,709 unique users, demonstrating strong community engagement. GeoLabel provides an operational, open-access example of how to integrate scalable labeling into a real-world workflow, with a clear path to broader adoption and continued expansion. -->

High-quality geospatial labels are a central prerequisite for training and validating machine learning models in Earth System Science. However, current labeling workflows face critical bottlenecks: limited support for large geospatial datasets, insufficient integration of geospatial context, lack of scalable web-based collaboration, and missing audit mechanisms for quality control. Existing tools are often not designed for georeferenced data, do not scale to large prediction layers, and provide limited support for distributed community contributions or AI-assisted editing.
GeoLabel addresses these challenges through the development of a scalable, browser-based, and community-driven correction and labeling system for geospatial machine learning outputs. The system enables users to directly review and edit model predictions in a web-based GIS environment, combining interactive polygon editing with optional AI-assisted boundary suggestions. A structured audit workflow ensures that community contributions remain transparent, reversible, and scientifically reliable.
The tool architecture integrates database-native vector tile generation, role-based editing and review workflows, and conflict-aware data handling to enable fast rendering and safe collaborative editing of large datasets. By combining high-performance geospatial visualization with AI-assisted labeling and built-in auditability, GeoLabel provides an operational solution to one of the major bottlenecks in geospatial ML: scalable, high-quality, and community-based label refinement.
The developed tools are showcased on the [deadtrees.earth](https://deadtrees.earth/) platform using high-resolution orthoimages as a real-world application case. In this context, GeoLabel enables the correction and refinement of model predictions for deadwood detection and forest cover mapping. This deployment demonstrates how large-scale orthomosaic-based segmentation outputs can be collaboratively reviewed and improved in a fully web-based environment, providing a transferable template for similar Earth observation workflows across domains.

## I. Introduction
<!-- Old Version> High-quality, geospatially explicit labels are essential for training machine learning models that support forest monitoring and Earth System Science. Traditional labeling tools are often limited to small datasets, lack geospatial context, and do not scale to the volume or diversity of data needed for robust models. GeoLabel aims to address these limitations by providing a practical, community-centered correction workflow for existing model predictions, with emphasis on scalability, auditability, and real-world usability.

The pilot focuses on enabling public, browser-based corrections to deadwood and forest cover predictions, while ensuring quality through a review process. The system is designed to be usable without local deployment and to support contributors across different institutions, data sources, and geographic regions. -->

Machine learning (ML) methods have become a cornerstone of Earth System Science (ESS), enabling large-scale mapping, monitoring, and modeling of complex environmental processes from remote sensing data. Applications range from vegetation structure and species mapping to disturbance detection, land cover classification, and ecosystem monitoring across spatial scales. However, the performance, transferability, and interpretability of these models critically depend on the availability of high-quality, geospatially explicit labels.

Despite rapid advances in model architectures and computational infrastructure, the generation and curation of reliable training and validation data remain major bottlenecks. In many ESS domains, labels are sparse, inconsistently formatted, spatially biased, or not preserved with sufficient metadata. Moreover, labeling workflows are often fragmented across tools that were not designed for large, georeferenced datasets. Conventional annotation software typically operates on small, non-geocoded image subsets, limiting spatial context, reducing interoperability, and complicating downstream reuse. As a result, researchers frequently resort to ad hoc workflows that combine GIS software, local scripts, and manual data handling—processes that are time-consuming, difficult to reproduce, and hard to scale.

Several core challenges can be identified:
* **Scalability**: Large orthomosaics, satellite time series, and dense prediction layers exceed the capacity of many conventional labeling tools. Efficient visualization and editing of millions of geometries require database-native and tile-based solutions.
* **Geospatial context**: Labels must remain spatially explicit, interoperable, and compatible with standard geospatial formats to enable reuse across tasks and resolutions. Currently, most labelled dataset are created on tiles with fixed size (e.g. 512x512 pixels) without geocoordinates, making reuse with different settings not possibl.
* **Collaboration**: Distributed community contributions are increasingly important, yet most tools lack robust role management, conflict handling, and web-based accessibility.
* **Auditability and quality control**: Open contribution models require structured review, versioning, and revert mechanisms to ensure scientific reliability.
* **AI-assisted workflows**: While automated segmentation models exist, few systems tightly integrate AI-assisted boundary refinement into interactive, browser-based editing environments. AI-assisted labelling could overcome labelling effort considerably.

GeoLabel addresses these bottlenecks by developing a scalable, web-based, and community-driven correction and labeling system for geospatial ML outputs. Rather than treating labeling as an isolated preprocessing step, GeoLabel integrates prediction review, correction, and audit mechanisms directly into a browser-accessible GIS workflow. The system is designed to handle large prediction layers derived from high-resolution Earth observation data, while preserving full geospatial context and metadata.

Technically, GeoLabel combines efficient brower-based visualization with role-based editing and review workflows. Corrections are stored separately from the original predictions, enabling reversible edits, structured approval processes, and full audit trails. AI-assisted segmentation can be optionally activated to support boundary delineation, improving efficiency without sacrificing transparency.

The pilot demonstrates this workflow in a real-world Earth observation context using high-resolution orthoimages, where deadwood and forest cover predictions are collaboratively reviewed and refined in high resolution drone imagery. By embedding correction tools directly within an operational platform, GeoLabel moves beyond conceptual tool design and provides a functional example of scalable, community-based geospatial label refinement.



## II. Results

### a) Implemented solution
GeoLabel is implemented as a public correction workflow integrated into [deadtrees.earth](https://deadtrees.earth/). Users review model predictions on high-resolution orthomosaics and propose edits directly on the map. The system supports three edit operations:

- Add missing polygons
- Modify existing polygons
- Delete incorrect polygons

<table>
<tr>
<td width="50%">
<img src="../../assets/deadtrees-editing-feature-add-missing-polygon-short-lots-zoom.gif" alt="Adding a missing polygon" width="100%"/>
<br/><em>Adding a missing deadwood polygon.</em>
</td>
<td width="50%">
<img src="../../assets/deadtrees-editing-feature-deletion.gif" alt="Deleting an incorrect polygon" width="100%"/>
<br/><em>Deleting an incorrect polygon.</em>
</td>
</tr>
</table>

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

- Multi-layer support: corrections can be applied to both deadwood and forest cover prediction layers.
- Correction styling: pending and approved edits are visually distinguished to communicate review status.
- Fast refresh after edits: vector tile sources are invalidated and reloaded to avoid stale visuals.

Editing capabilities were a core focus of the pilot. The editor provides a fast, low-friction entry into editing mode and offers the following tools:

- Polygon drawing with freehand placement to add missing objects.
- AI-assisted segmentation (currently SegmentAnything) to propose boundaries from user input (rectangles).
- Cut, merge, and clip operations to refine polygon topology.
- Delete and undo actions to correct mistakes quickly.
<!-- Did not understand this: - Inline editing without page transitions, with predictions loaded into an overlay for immediate editing. -->

Keyboard-first interaction is supported to reduce friction during detailed edits. For this, a series of keyboard shortcuts was implemented:

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
- Backend repository (public, MIT): https://github.com/Deadwood-ai/deadtrees-backend
- Frontend repository: https://github.com/Deadwood-ai/deadtrees-frontend
- Pilot documentation: `docs/projects/geolabel/`

The platform provides open access to datasets, prediction layers, and the GeoLabel correction workflows. Documentation includes user guidance, technical overviews, and detailed descriptions of the correction workflow.

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
- Backend repository (public, MIT): https://github.com/Deadwood-ai/deadtrees-backend
- Frontend repository: https://github.com/Deadwood-ai/deadtrees-frontend
- Pilot documentation: `docs/projects/geolabel/`

The platform provides open access to datasets, prediction layers, and correction workflows. Documentation includes user guidance, technical overviews, and detailed descriptions of the correction workflow.

### c) Innovation and FAIRness
The key innovation is a community-first, audit-ready correction system applied directly to model outputs, rather than isolated labeling tasks. This approach supports:

- Findability and accessibility: open access to datasets and corrections via a public platform.
- Interoperability: PostGIS-based geospatial standards and APIs; use of common geospatial data formats for labelled data (geopackage and GeoTIFF format).
- Reusability: corrections are tracked, reviewed, and preserved with history, supporting downstream model training and validation.

<!-- Old version GeoLabel also demonstrates a scalable approach to collaborative labeling that can be adapted to other domains in Earth System Science.-->

GeoLabel also demonstrates a scalable approach to collaborative labeling that can be adapted to other domains in Earth System Science. Its modular architecture allows the integration of different data types, prediction layers, and labeling tasks without fundamental changes to the core system. By combining database-native geospatial processing, browser-based editing, and structured audit workflows, the approach can be transferred to applications such as land cover mapping, habitat delineation, cryosphere monitoring, or coastal change detection. This flexibility makes GeoLabel not only a domain-specific solution, but a generalizable framework for community-driven, AI-assisted geospatial data curation

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

<!-- GeoLabel targets a critical bottleneck in geospatial ML: scalable, high-quality labeling that can be performed by a distributed community while remaining scientifically trustworthy. The pilot demonstrates how public participation and strong audit controls can coexist in a single workflow. -->

The GeoLabel team has been highly active in presenting and discussing the pilot at international conferences, workshops, and community meetings, with a strong focus on research data management (RDM), FAIR principles, and scalable geospatial infrastructures. The underlying concepts, system architecture, and demonstrator use case were continuously communicated to both the Earth System Science and NFDI communities, fostering dialogue on collaborative labeling and AI-ready data workflows. In addition, the conceptual and methodological foundations and application context have been formalized in peer-reviewed publications, strengthening the scientific visibility and long-term impact of the initiative.

Community uptake indicators (last 12 months):

- 5,919 datasets submitted
- 158 unique submitters
- 16,709 unique users (based on distinct pageview users)

Outreach and visibility include:

- Joint NFDI4Earth & NFDI4Biodiversity Plenary 2025 (Bremen) on the GeoLabel pilot
- SmartForest 2025: deadtrees.earth: Crowd-Sourced Imagery and AI for Global Insights into Tree Mortality Dynamics
- Dreilaendertagung 2025: From Local Drones to Global Insights: AI-Driven Tree Mortality Mapping with Remote Sensing
- EGU 2025 & EGU 2026 talks on the deadtrees.earth platform and related RDM activities
- Living Planet Symposium 2025 and BioSpace 2025 presentations
- International Tree Mortality Network seminar (2024)

Publications:
- Mosig, C., Vajna-Jehle, J., Mahecha, M. D., Cheng, Y., Hartmann, H., Montero, D., Junttila, S., Horion, S., Schwenke, M. B., ... & Kattenborn, T. (2026). *deadtrees.earth – An open-access and interactive database for centimeter-scale aerial imagery to uncover global tree mortality dynamics*. Remote Sensing of Environment, 332, 115027. https://doi.org/10.1016/j.rse.2025.115027
- Möhring, J., Kattenborn, T., Mahecha, M. D., Cheng, Y., Beloiu Schwenke, M., Cloutier, M., Denter, M., Frey, J., Gassilloud, M., Göritz, A., Hempel, J., Horion, S., Jucker, T., Junttila, S., Khatri-Chhetri, P., Korznikov, K., Kruse, S., Laliberté, E., Maroschek, M., Neumeier, P., Pérez-Priego, O., Potts, A., Schiefer, F., Seidl, R., Vajna-Jehle, J., Zielewska-Büttner, K., & Mosig, C. (2025). Global, multi-scale standing deadwood segmentation in centimeter-scale aerial images. ISPRS Open Journal of Photogrammetry and Remote Sensing. https://doi.org/10.1016/j.ophoto.2025.100104


## V. Future directions
GeoLabel establishes a robust public correction workflow, but there is still substantial opportunity for growth. The pilot shows that community labeling at scale is feasible when performance, auditability, and usability are addressed together. The next steps focus on strengthening adoption, expanding feature coverage, and ensuring long-term sustainability:

- Expand correction workflows to additional label types and domains.
- Improve analytical tooling around correction impact and reviewer throughput.
- Provide enriched dataset metadata and tighter linkage to publications.
- Support broader integration into external workflows and third-party systems.
- Continue outreach to grow the contributor base and diversify geographic coverage.
- Integrate crowd-sourced labels into active supervised AI training workflows.


## Publications and related outputs (selected)
- Mosig, C., Vajna-Jehle, J., Mahecha, M. D., Cheng, Y., Hartmann, H., Montero, D., Junttila, S., Horion, S., Schwenke, M. B., ... & Kattenborn, T. (2026). *deadtrees.earth – An open-access and interactive database for centimeter-scale aerial imagery to uncover global tree mortality dynamics*. Remote Sensing of Environment, 332, 115027. https://doi.org/10.1016/j.rse.2025.115027
- Möhring, J., Kattenborn, T., Mahecha, M. D., Cheng, Y., Beloiu Schwenke, M., Cloutier, M., Denter, M., Frey, J., Gassilloud, M., Göritz, A., Hempel, J., Horion, S., Jucker, T., Junttila, S., Khatri-Chhetri, P., Korznikov, K., Kruse, S., Laliberté, E., Maroschek, M., Neumeier, P., Pérez-Priego, O., Potts, A., Schiefer, F., Seidl, R., Vajna-Jehle, J., Zielewska-Büttner, K., & Mosig, C. (2025). Global, multi-scale standing deadwood segmentation in centimeter-scale aerial images. ISPRS Open Journal of Photogrammetry and Remote Sensing. https://doi.org/10.1016/j.ophoto.2025.100104

## Figures and screenshots
Figure placeholders to be added in the final version:
- Figure 1: Correction workflow overview (user edit -> audit -> approval)
- Figure 2: Example correction before/after
- Figure 3: System architecture (frontend, database, PostGIS tile generation)

