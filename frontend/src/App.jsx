import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import "./App.css";

const API_URL = "https://guard-ai-backend.onrender.com";

// Each browser must upload its own dataset before seeing the dashboard.
const FIRST_USE_KEY = "guard_ai_first_use_complete";

const safeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const formatAmount = (amount) => {
  const value = safeNumber(amount);

  if (value >= 10000000) {
    return `₹${(value / 10000000).toFixed(2)}Cr`;
  }

  if (value >= 100000) {
    return `₹${(value / 100000).toFixed(1)}L`;
  }

  if (value >= 1000) {
    return `₹${(value / 1000).toFixed(1)}K`;
  }

  return `₹${value.toLocaleString("en-IN")}`;
};

const getRiskScore = (project) => {
  return Math.round(
    safeNumber(
      project?.risk_score ??
        project?.riskScore ??
        project?.score ??
        0
    )
  );
};

const getRiskLevel = (project) => {
  const level =
    project?.risk_level ??
    project?.riskLevel ??
    project?.risk ??
    "";

  if (level) {
    return String(level);
  }

  const score = getRiskScore(project);

  if (score > 60) return "High";
  if (score > 30) return "Medium";

  return "Low";
};

const getRiskClass = (risk) => {
  return String(risk || "Low").toLowerCase();
};

const getRiskColor = (risk) => {
  const value = String(risk || "").toLowerCase();

  if (value === "high") return "#ef4444";
  if (value === "medium") return "#f59e0b";

  return "#10b981";
};


/* =====================================================
   RISK EXPLANATION / RECOMMENDATION HELPERS
   ===================================================== */

const getRiskMetrics = (project) => {
  const estimatedCost = safeNumber(project?.estimated_cost);
  const actualExpenditure = safeNumber(project?.actual_expenditure);
  const sanctionedAmount = safeNumber(project?.sanctioned_amount);
  const amountReleased = safeNumber(project?.amount_released);
  const amountUtilized = safeNumber(project?.amount_utilized);

  const calculatedCostDeviation =
    estimatedCost > 0
      ? ((actualExpenditure - estimatedCost) / estimatedCost) * 100
      : 0;

  const calculatedBudgetUsage =
    estimatedCost > 0
      ? (actualExpenditure / estimatedCost) * 100
      : 0;

  const calculatedReleaseUtilization =
    amountReleased > 0
      ? (amountUtilized / amountReleased) * 100
      : 0;

  const calculatedSanctionUtilization =
    sanctionedAmount > 0
      ? (amountUtilized / sanctionedAmount) * 100
      : 0;

  return {
    estimatedCost,
    actualExpenditure,
    sanctionedAmount,
    amountReleased,
    amountUtilized,
    costDeviation: safeNumber(
      project?.cost_deviation_pct ?? calculatedCostDeviation
    ),
    budgetUsage: calculatedBudgetUsage,
    releaseUtilization: safeNumber(
      project?.fund_utilization_pct ??
        project?.utilization_pct ??
        calculatedReleaseUtilization
    ),
    sanctionUtilization: calculatedSanctionUtilization,
    delayDays: Math.round(safeNumber(project?.delay_days)),
  };
};

const getRiskReasons = (project) => {
  const metrics = getRiskMetrics(project);
  const reasons = [];

  if (metrics.costDeviation > 20) {
    reasons.push({
      type: "Cost Overrun",
      description: `Actual expenditure is ${metrics.costDeviation.toFixed(
        1
      )}% above the estimated project cost.`,
      action:
        "Verify bills, quotations, approvals and any approved scope changes before further expenditure.",
      severity: "high",
    });
  }

  if (metrics.delayDays > 60) {
    reasons.push({
      type: "Project Delay",
      description: `The project is delayed by approximately ${metrics.delayDays} days beyond the expected completion date.`,
      action:
        "Review the implementation timeline, identify the cause of delay and obtain an updated completion plan.",
      severity: "high",
    });
  }

  if (
    metrics.releaseUtilization < 50 &&
    metrics.amountReleased > 0
  ) {
    reasons.push({
      type: "Low Fund Utilization",
      description: `Only ${metrics.releaseUtilization.toFixed(
        1
      )}% of the released funds are recorded as utilized.`,
      action:
        "Verify pending bills, physical progress and the reason for unutilized released funds before releasing additional funds.",
      severity: "medium",
    });
  }

  if (
    Array.isArray(project?.explanations) &&
    project.explanations.some((item) =>
      String(item).toLowerCase().includes("vendor")
    )
  ) {
    reasons.push({
      type: "Vendor Concentration",
      description:
        "The vendor pattern is unusual compared with other projects in the uploaded dataset.",
      action:
        "Review vendor allocation, procurement records and supporting approvals for concentration or repeated assignment.",
      severity: "medium",
    });
  }

  if (reasons.length === 0) {
    const level = getRiskLevel(project).toLowerCase();

    if (level === "high") {
      reasons.push({
        type: "ML Anomaly",
        description:
          "The machine-learning model identified an unusual combination of project attributes.",
        action:
          "Compare the project with similar projects and perform document-level verification before final action.",
        severity: "high",
      });
    } else if (level === "medium") {
      reasons.push({
        type: "Pattern Review",
        description:
          "The project shows a moderately unusual pattern that deserves review.",
        action:
          "Compare costs, progress, utilization and timelines with similar projects.",
        severity: "medium",
      });
    } else {
      reasons.push({
        type: "No Major Rule Trigger",
        description:
          "No major rule-based risk indicator was triggered by the available project fields.",
        action:
          "Continue routine monitoring and update the record as project progress changes.",
        severity: "low",
      });
    }
  }

  return reasons;
};

const getPrimaryRiskName = (project) => {
  const reasons = getRiskReasons(project);
  const names = reasons
    .filter((reason) => reason.type !== "No Major Rule Trigger")
    .map((reason) => reason.type);

  if (names.length === 0) return "Normal Pattern";
  if (names.length === 1) return names[0];

  if (names.includes("Cost Overrun") && names.includes("Project Delay")) {
    return "Cost Overrun + Delay";
  }

  if (names.includes("Cost Overrun")) return "Cost Overrun + Review";
  if (names.includes("Project Delay")) return "Project Delay + Review";
  return names.slice(0, 2).join(" + ");
};

const getRiskOpinion = (project) => {
  const level = getRiskLevel(project).toLowerCase();

  if (level === "high") {
    return {
      label: "Requires Verification",
      icon: "⚠️",
      text:
        "The project shows significant anomalous patterns. It should be reviewed by an authorized official before final action or additional fund release.",
      className: "high",
    };
  }

  if (level === "medium") {
    return {
      label: "Review Recommended",
      icon: "🟠",
      text:
        "The project has some unusual indicators. A targeted review is recommended, but the anomaly alone does not establish wrongdoing.",
      className: "medium",
    };
  }

  return {
    label: "Appears Within Normal Pattern",
    icon: "✓",
    text:
      "The available project data does not show a major rule-based anomaly. Continue routine monitoring.",
    className: "low",
  };
};

const getBudgetStatus = (project) => {
  const metrics = getRiskMetrics(project);

  if (metrics.estimatedCost <= 0) {
    return {
      label: "Insufficient Cost Data",
      className: "neutral",
    };
  }

  if (metrics.budgetUsage > 120) {
    return {
      label: "Severely Over Budget",
      className: "danger",
    };
  }

  if (metrics.budgetUsage > 100) {
    return {
      label: "Over Budget",
      className: "danger",
    };
  }

  if (metrics.budgetUsage >= 80) {
    return {
      label: "High Budget Usage",
      className: "warning",
    };
  }

  return {
    label: "Within Estimated Budget",
    className: "good",
  };
};

const getProjectsFromResponse = (data) => {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.projects)) {
    return data.projects;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.anomalies)) {
    return data.anomalies;
  }

  return [];
};

function App() {
  const [stats, setStats] = useState({
    total_projects: 0,
    high_risk: 0,
    medium_risk: 0,
    low_risk: 0,
    total_sanctioned_amount: 0,
    total_utilized_amount: 0,
  });

  const [projects, setProjects] = useState([]);
  const [anomalies, setAnomalies] = useState([]);

  const [selectedProject, setSelectedProject] = useState(null);

  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);

  const [isFirstUse, setIsFirstUse] = useState(() => {
    try {
      return localStorage.getItem(FIRST_USE_KEY) !== "true";
    } catch {
      return true;
    }
  });

  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");

  const [dragActive, setDragActive] = useState(false);

  const [riskFilter, setRiskFilter] = useState("All");

  const [verificationStatus, setVerificationStatus] =
    useState({});

  const [investigationProjectId, setInvestigationProjectId] =
    useState(null);

  const fileInputRef = useRef(null);

  useEffect(() => {
    // Brand-new browser/user: show the upload screen first, even if the
    // backend currently contains another dataset.
    if (isFirstUse) {
      setLoading(false);
      setHasData(false);
      return;
    }

    checkForData();
  }, [isFirstUse]);

  /* =====================================================
     LOAD DASHBOARD DATA
     ===================================================== */

  const loadAllData = async () => {
    try {
      const [
        statsResponse,
        projectsResponse,
        anomaliesResponse,
      ] = await Promise.all([
        axios.get(`${API_URL}/dashboard/stats`),
        axios.get(`${API_URL}/projects`),
        axios.get(`${API_URL}/anomalies`),
      ]);

      const backendStats =
        statsResponse.data || {};

      const allProjects =
        getProjectsFromResponse(
          projectsResponse.data
        );

      const backendAnomalies =
        getProjectsFromResponse(
          anomaliesResponse.data
        );

      const completeProjects =
        allProjects.length > 0
          ? allProjects
          : backendAnomalies;

      setProjects(completeProjects);
      setAnomalies(backendAnomalies);

      /* =================================================
         RISK COUNTS
         ================================================= */

      let highRisk = safeNumber(
        backendStats.high_risk ??
          backendStats.high_risk_projects
      );

      let mediumRisk = safeNumber(
        backendStats.medium_risk ??
          backendStats.medium_risk_projects
      );

      let lowRisk = safeNumber(
        backendStats.low_risk ??
          backendStats.low_risk_projects
      );

      const projectRiskCounts = {
        high: 0,
        medium: 0,
        low: 0,
      };

      completeProjects.forEach((project) => {
        const risk =
          getRiskLevel(project).toLowerCase();

        if (risk === "high") {
          projectRiskCounts.high += 1;
        } else if (risk === "medium") {
          projectRiskCounts.medium += 1;
        } else {
          projectRiskCounts.low += 1;
        }
      });

      if (
        highRisk === 0 &&
        mediumRisk === 0 &&
        lowRisk === 0 &&
        completeProjects.length > 0
      ) {
        highRisk = projectRiskCounts.high;
        mediumRisk = projectRiskCounts.medium;
        lowRisk = projectRiskCounts.low;
      }

      /* =================================================
         TOTAL PROJECTS
         ================================================= */

      const totalProjects =
        safeNumber(
          backendStats.total_projects ??
            backendStats.total_project_count
        ) || completeProjects.length;

      /* =================================================
         FINANCIAL TOTALS
         ================================================= */

      let sanctioned = safeNumber(
        backendStats.total_sanctioned_amount ??
          backendStats.total_sanctioned ??
          backendStats.sanctioned_amount
      );

      let utilized = safeNumber(
        backendStats.total_utilized_amount ??
          backendStats.total_utilized ??
          backendStats.amount_utilized
      );

      if (
        sanctioned === 0 &&
        completeProjects.length > 0
      ) {
        sanctioned =
          completeProjects.reduce(
            (sum, project) =>
              sum +
              safeNumber(
                project.sanctioned_amount
              ),
            0
          );
      }

      if (
        utilized === 0 &&
        completeProjects.length > 0
      ) {
        utilized =
          completeProjects.reduce(
            (sum, project) =>
              sum +
              safeNumber(
                project.amount_utilized ??
                  project.utilized_amount ??
                  project.actual_expenditure
              ),
            0
          );
      }

      const finalStats = {
        total_projects: totalProjects,
        high_risk: highRisk,
        medium_risk: mediumRisk,
        low_risk: lowRisk,
        total_sanctioned_amount:
          sanctioned,
        total_utilized_amount:
          utilized,
      };

      setStats(finalStats);
      setHasData(totalProjects > 0);

      return {
        stats: finalStats,
        projects: completeProjects,
        anomalies: backendAnomalies,
      };
    } catch (error) {
      console.error(
        "Failed to load dashboard:",
        error
      );

      setProjects([]);
      setAnomalies([]);

      setStats({
        total_projects: 0,
        high_risk: 0,
        medium_risk: 0,
        low_risk: 0,
        total_sanctioned_amount: 0,
        total_utilized_amount: 0,
      });

      setHasData(false);

      throw error;
    }
  };

  const checkForData = async () => {
    try {
      setLoading(true);
      await loadAllData();
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  /* =====================================================
     FILE UPLOAD
     ===================================================== */

  const validateFile = (file) => {
    if (!file) return false;

    const extension = file.name
      .toLowerCase()
      .split(".")
      .pop();

    return ["csv", "xlsx", "pdf"].includes(
      extension
    );
  };

  const selectFile = (file) => {
    setUploadMessage("");
    setUploadError("");

    if (!file) return;

    if (!validateFile(file)) {
      setSelectedFile(null);

      setUploadError(
        "Unsupported file format. Please upload CSV, XLSX, or PDF."
      );

      return;
    }

    setSelectedFile(file);
  };

  const handleFileChange = (event) => {
    const file =
      event.target.files?.[0];

    if (file) {
      selectFile(file);
    }
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();

    setDragActive(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();

    setDragActive(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();

    setDragActive(false);

    const file =
      event.dataTransfer.files?.[0];

    if (file) {
      selectFile(file);
    }
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadError(
        "Please select a file first."
      );
      return;
    }

    try {
      setUploading(true);

      setUploadMessage("");
      setUploadError("");

      const formData =
        new FormData();

      formData.append(
        "file",
        selectedFile
      );

      const response =
        await axios.post(
          `${API_URL}/upload`,
          formData,
          {
            headers: {
              "Content-Type":
                "multipart/form-data",
            },
          }
        );

      const result =
        await loadAllData();

      const total =
        safeNumber(
          response.data
            ?.total_projects
        ) ||
        safeNumber(
          result?.stats
            ?.total_projects
        ) ||
        result?.projects
          ?.length ||
        0;

      if (total > 0) {
        try {
          localStorage.setItem(FIRST_USE_KEY, "true");
        } catch {
          // If browser storage is unavailable, the current session still works.
        }

        setIsFirstUse(false);
        setHasData(true);

        setUploadMessage(
          `Successfully analyzed ${total} projects.`
        );

        setSelectedFile(null);

        if (fileInputRef.current) {
          fileInputRef.current.value =
            "";
        }
      } else {
        setHasData(false);

        setUploadError(
          "The file was uploaded, but no project records were returned for analysis."
        );
      }
    } catch (error) {
      console.error(
        "Upload failed:",
        error
      );

      setUploadError(
        error.response?.data
          ?.detail ||
          "Upload failed. Please check the file format and required columns."
      );
    } finally {
      setUploading(false);
    }
  };

  /* =====================================================
     REFRESH
     ===================================================== */

  const loadDashboard = async () => {
    try {
      setLoading(true);

      await loadAllData();
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  /* =====================================================
     PROJECT DETAILS
     ===================================================== */

  const openProject = async (
    projectId
  ) => {
    try {
      const response =
        await axios.get(
          `${API_URL}/projects/${projectId}`
        );

      setSelectedProject(
        response.data
      );
    } catch (error) {
      console.error(
        "Failed to load project details:",
        error
      );

      const localProject =
        projects.find(
          (project) =>
            String(
              project.project_id
            ) ===
            String(projectId)
        );

      if (localProject) {
        setSelectedProject(
          localProject
        );
      }
    }
  };

  /* =====================================================
     VERIFICATION
     ===================================================== */

  const markForVerification = (
    projectId
  ) => {
    setVerificationStatus(
      (previous) => ({
        ...previous,
        [projectId]:
          "Marked for Verification",
      })
    );
  };

  /* =====================================================
     FILTERED PROJECTS
     ===================================================== */

  const filteredProjects =
    useMemo(() => {
      const sorted = [
        ...projects,
      ].sort(
        (a, b) =>
          getRiskScore(b) -
          getRiskScore(a)
      );

      if (riskFilter === "All") {
        return sorted;
      }

      return sorted.filter(
        (project) =>
          getRiskLevel(
            project
          ).toLowerCase() ===
          riskFilter.toLowerCase()
      );
    }, [
      projects,
      riskFilter,
    ]);

  /* =====================================================
     RISK DISTRIBUTION
     ===================================================== */

  const riskDistribution = [
    {
      name: "High Risk",
      value: stats.high_risk,
      color: "#ef4444",
    },
    {
      name: "Medium Risk",
      value: stats.medium_risk,
      color: "#f59e0b",
    },
    {
      name: "Low Risk",
      value: stats.low_risk,
      color: "#10b981",
    },
  ];

  const hasRiskData =
    riskDistribution.some(
      (item) => item.value > 0
    );

  /* =====================================================
     RISK SCORE CHART
     ===================================================== */

  const riskScoreData =
    useMemo(() => {
      return [...projects]
        .sort(
          (a, b) =>
            getRiskScore(b) -
            getRiskScore(a)
        )
        .slice(0, 10)
        .map((project) => ({
          name:
            project.project_name ||
            project.project_id ||
            "Project",
          projectId: project.project_id || "Project",
          projectName: project.project_name || project.project_id || "Project",
          riskType: getPrimaryRiskName(project),
          score: getRiskScore(project),
          risk: getRiskLevel(project),
          riskReasons: getRiskReasons(project),
        }));
    }, [projects]);

  /* =====================================================
     AI INVESTIGATION WORKSPACE
     ===================================================== */

  const investigationProjects = useMemo(() => {
    return [...projects]
      .filter(
        (project) =>
          getRiskLevel(project) !== "Low"
      )
      .sort(
        (a, b) =>
          getRiskScore(b) -
          getRiskScore(a)
      )
      .slice(0, 6);
  }, [projects]);

  const activeInvestigationProject =
    investigationProjects.find(
      (project) =>
        project.project_id ===
        investigationProjectId
    ) ||
    investigationProjects[0] ||
    projects[0] ||
    null;

  const investigationTasks =
    activeInvestigationProject
      ? getRiskReasons(
          activeInvestigationProject
        )
      : [];

  useEffect(() => {
    if (
      investigationProjects.length > 0 &&
      !investigationProjects.some(
        (project) =>
          project.project_id ===
          investigationProjectId
      )
    ) {
      setInvestigationProjectId(
        investigationProjects[0].project_id
      );
    }
  }, [
    investigationProjects,
    investigationProjectId,
  ]);

  /* =====================================================
     FINANCIAL
     ===================================================== */

  const utilization =
    stats.total_sanctioned_amount >
    0
      ? Math.min(
          100,
          (stats.total_utilized_amount /
            stats.total_sanctioned_amount) *
            100
        )
      : 0;

  /* =====================================================
     NAVIGATION
     ===================================================== */

  const scrollToSection = (
    id
  ) => {
    document
      .getElementById(id)
      ?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
  };

  /* =====================================================
     LOADING SCREEN
     ===================================================== */

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-card">

          <div className="brand-icon">
            G
          </div>

          <h2>GUARD AI</h2>

          <p>
            Loading project risk
            intelligence...
          </p>

          <div className="loading-spinner"></div>

        </div>
      </div>
    );
  }

  /* =====================================================
     NO DATA SCREEN
     ===================================================== */

  if (!hasData) {
    return (
      <div className="upload-screen">

        <div className="upload-card">

          <div className="upload-logo">
            G
          </div>

          <h1>
            GUARD AI
          </h1>

          <p className="upload-description">
            AI-powered anomaly detection
            and risk intelligence for
            MPLAD implementation data.
          </p>

          <div
            className={`upload-box ${
              dragActive
                ? "drag-active"
                : ""
            }`}
            onDragOver={
              handleDragOver
            }
            onDragLeave={
              handleDragLeave
            }
            onDrop={handleDrop}
            onClick={
              openFilePicker
            }
          >

            <div className="upload-icon">
              ↑
            </div>

            <h3>
              Upload Project Dataset
            </h3>

            <p>
              Drag & drop your file
              here or{" "}
              <span>
                browse from your
                computer
              </span>
            </p>

            <small>
              Supported formats:
              CSV, XLSX, PDF
            </small>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              onChange={
                handleFileChange
              }
              hidden
            />

          </div>

          {selectedFile && (
            <div className="selected-file">

              <strong>
                {selectedFile.name}
              </strong>

              <span>
                {(
                  selectedFile.size /
                  1024
                ).toFixed(1)}{" "}
                KB
              </span>

            </div>
          )}

          <button
            className="upload-button"
            onClick={
              handleUpload
            }
            disabled={
              !selectedFile ||
              uploading
            }
          >
            {uploading
              ? "Analyzing..."
              : "Analyze Dataset"}
          </button>

          <p className="upload-note">
            New users start here. No project data is displayed until you upload a dataset.
          </p>

          <p className="upload-disclaimer">
            The AI identifies anomalous
            patterns and prioritizes
            records for human
            verification. It does not
            independently prove fraud.
          </p>

          {uploadMessage && (
            <div className="upload-success">
              {uploadMessage}
            </div>
          )}

          {uploadError && (
            <div className="upload-error">
              {uploadError}
            </div>
          )}

        </div>

      </div>
    );
  }

  /* =====================================================
     DASHBOARD
     ===================================================== */

  return (
    <div className="app">

      {/* SIDEBAR */}

      <aside className="sidebar">

        <div className="brand">

          <div className="brand-icon">
            G
          </div>

          <div>
            <strong>
              GUARD AI
            </strong>

            <span>
              Risk Intelligence
            </span>
          </div>

        </div>

        <nav>

          <button
            className="nav-item active"
            onClick={() =>
              scrollToSection(
                "dashboard"
              )
            }
          >
            <span>▦</span>
            Dashboard
          </button>

          <button
            className="nav-item"
            onClick={() =>
              scrollToSection(
                "projects"
              )
            }
          >
            <span>▤</span>
            Projects
          </button>

          <button
            className="nav-item"
            onClick={() =>
              scrollToSection(
                "anomalies"
              )
            }
          >
            <span>⚠</span>
            Anomalies
          </button>

          <button
            className="nav-item"
            onClick={() =>
              scrollToSection(
                "analytics"
              )
            }
          >
            <span>◫</span>
            Analytics
          </button>

          <button
            className="nav-item"
            onClick={() =>
              scrollToSection(
                "investigation"
              )
            }
          >
            <span>✦</span>
            AI Investigation
          </button>

          <button
            className="nav-item"
            onClick={() =>
              scrollToSection(
                "verification"
              )
            }
          >
            <span>✓</span>
            Verification
          </button>

        </nav>

        <div className="sidebar-footer">

          <div className="status-dot"></div>

          <div>
            <strong>
              AI Engine Online
            </strong>

            <span>
              Isolation Forest + Rules
            </span>
          </div>

        </div>

      </aside>

      {/* MAIN */}

      <main className="main">

        {/* TOPBAR */}

        <header className="topbar">

          <div>

            <h1>
              Implementation Risk
              Dashboard
            </h1>

            <p>
              AI-assisted monitoring of
              uploaded MPLAD project
              data
            </p>

          </div>

          <button
            className="refresh-button"
            onClick={
              loadDashboard
            }
            disabled={loading}
          >
            ↻{" "}
            {loading
              ? "Refreshing..."
              : "Refresh"}
          </button>

        </header>

        {/* =================================================
            STATS
            ================================================= */}

        <section id="dashboard">

          <div className="stats-grid">

            <div className="stat-card">

              <div className="stat-icon blue">
                ▦
              </div>

              <div>

                <span className="stat-label">
                  Total Projects
                </span>

                <strong>
                  {
                    stats.total_projects
                  }
                </strong>

              </div>

            </div>

            <div className="stat-card high">

              <div className="stat-icon red">
                ⚠
              </div>

              <div>

                <span className="stat-label">
                  High Risk
                </span>

                <strong>
                  {stats.high_risk}
                </strong>

              </div>

            </div>

            <div className="stat-card medium">

              <div className="stat-icon orange">
                !
              </div>

              <div>

                <span className="stat-label">
                  Medium Risk
                </span>

                <strong>
                  {stats.medium_risk}
                </strong>

              </div>

            </div>

            <div className="stat-card low">

              <div className="stat-icon green">
                ✓
              </div>

              <div>

                <span className="stat-label">
                  Low Risk
                </span>

                <strong>
                  {stats.low_risk}
                </strong>

              </div>

            </div>

          </div>

        </section>

        {/* =================================================
            UPLOAD
            ================================================= */}

        <section className="panel upload-panel">

          <div className="panel-header">

            <div>

              <h2>
                Analyze New Dataset
              </h2>

              <p>
                Upload another project
                dataset to replace the
                current analysis.
              </p>

            </div>

          </div>

          <div
            className={`upload-area ${
              dragActive
                ? "drag-active"
                : ""
            }`}
            onDragOver={
              handleDragOver
            }
            onDragLeave={
              handleDragLeave
            }
            onDrop={handleDrop}
          >

            <div>

              <strong>
                Drop CSV, XLSX or PDF
                here
              </strong>

              <span>
                or select a file from
                your computer
              </span>

            </div>

            <button
              className="secondary-button"
              onClick={
                openFilePicker
              }
            >
              Choose File
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              onChange={
                handleFileChange
              }
              hidden
            />

          </div>

          {selectedFile && (
            <div className="selected-file">

              <strong>
                {selectedFile.name}
              </strong>

              <button
                onClick={
                  handleUpload
                }
                disabled={uploading}
              >
                {uploading
                  ? "Analyzing..."
                  : "Analyze"}
              </button>

            </div>
          )}

          {uploadMessage && (
            <div className="upload-success">
              {uploadMessage}
            </div>
          )}

          {uploadError && (
            <div className="upload-error">
              {uploadError}
            </div>
          )}

        </section>

        {/* =================================================
            ANALYTICS
            ================================================= */}

        <section
          id="analytics"
          className="content-grid"
        >

          {/* RISK DISTRIBUTION */}

          <div className="panel chart-container">

            <div className="panel-header">

              <div>

                <h2>
                  Risk Distribution
                </h2>

                <p>
                  AI classification of
                  analyzed projects
                </p>

              </div>

            </div>

            {hasRiskData ? (
              <>

                <div className="pie-wrapper">

                  <ResponsiveContainer
                    width="100%"
                    height={280}
                  >

                    <PieChart>

                      <Pie
                        data={
                          riskDistribution
                        }
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={68}
                        outerRadius={105}
                        paddingAngle={5}
                      >

                        {riskDistribution.map(
                          (entry) => (
                            <Cell
                              key={
                                entry.name
                              }
                              fill={
                                entry.color
                              }
                            />
                          )
                        )}

                      </Pie>

                      <text
                        x="50%"
                        y="47%"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#172033"
                        fontSize="28"
                        fontWeight="800"
                      >
                        {
                          stats.total_projects
                        }
                      </text>

                      <text
                        x="50%"
                        y="58%"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#69758a"
                        fontSize="11"
                        fontWeight="700"
                      >
                        PROJECTS
                      </text>

                      <Tooltip />

                    </PieChart>

                  </ResponsiveContainer>

                </div>

                <div className="legend">

                  {riskDistribution.map(
                    (item) => (
                      <div
                        key={
                          item.name
                        }
                        className="legend-item"
                      >

                        <span
                          className="legend-dot"
                          style={{
                            background:
                              item.color,
                          }}
                        ></span>

                        <span>
                          {item.name}
                        </span>

                        <strong>
                          {item.value}
                        </strong>

                      </div>
                    )
                  )}

                </div>

              </>
            ) : (

              <div className="meaningful-empty">

                <div className="empty-icon">
                  ◌
                </div>

                <h3>
                  Risk profile ready
                </h3>

                <p>
                  The uploaded dataset is
                  being evaluated for
                  anomaly patterns.
                </p>

              </div>

            )}

          </div>

          {/* FUND OVERVIEW */}

          <div className="panel financial-panel">

            <div className="panel-header">

              <div>

                <h2>
                  Fund Overview
                </h2>

                <p>
                  Financial utilization
                  of uploaded projects
                </p>

              </div>

            </div>

            <div className="money-card">

              <span>
                Total Sanctioned
              </span>

              <strong>
                {formatAmount(
                  stats.total_sanctioned_amount
                )}
              </strong>

            </div>

            <div className="money-card">

              <span>
                Total Utilized
              </span>

              <strong>
                {formatAmount(
                  stats.total_utilized_amount
                )}
              </strong>

            </div>

            <div className="utilization">

              <div className="utilization-header">

                <span>
                  Overall Utilization
                </span>

                <strong>
                  {utilization.toFixed(
                    1
                  )}
                  %
                </strong>

              </div>

              <div className="progress">

                <div
                  className="progress-fill"
                  style={{
                    width: `${utilization}%`,
                  }}
                ></div>

              </div>

            </div>

          </div>

        </section>

        {/* =================================================
            HIGHEST RISK PROJECTS
            ================================================= */}

        <section className="panel risk-score-panel">

          <div className="panel-header">

            <div>

              <h2>
                Highest Risk Projects
              </h2>

              <p>
                Risk scores generated from
                rule-based indicators and
                machine-learning anomaly
                detection.
              </p>

            </div>

          </div>

          {riskScoreData.length > 0 ? (
            <>
            <div className="risk-chart">

              <ResponsiveContainer
                width="100%"
                height={340}
              >

                <BarChart
                  data={
                    riskScoreData
                  }
                  margin={{
                    top: 10,
                    right: 20,
                    left: 5,
                    bottom: 55,
                  }}
                >

                  <CartesianGrid
                    strokeDasharray="3 3"
                  />

                  <XAxis
                    dataKey="name"
                    angle={-22}
                    textAnchor="end"
                    interval={0}
                    height={82}
                    tick={{
                      fill: "#4b5563",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  />

                  <YAxis
                    domain={[0, 100]}
                    tick={{
                      fill: "#6b7280",
                      fontSize: 12,
                    }}
                    label={{
                      value: "Risk Score",
                      angle: -90,
                      position: "insideLeft",
                    }}
                  />

                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;

                      const item = payload[0]?.payload;
                      if (!item) return null;

                      return (
                        <div
                          style={{
                            background: "#ffffff",
                            border: "1px solid #e5e7eb",
                            borderRadius: "12px",
                            padding: "12px 14px",
                            boxShadow:
                              "0 10px 30px rgba(15, 23, 42, 0.14)",
                            minWidth: "220px",
                          }}
                        >
                          <strong
                            style={{
                              display: "block",
                              color: "#172033",
                              fontSize: "14px",
                              marginBottom: "5px",
                            }}
                          >
                            {item.projectName}
                          </strong>

                          <span
                            style={{
                              display: "block",
                              color: "#64748b",
                              fontSize: "12px",
                              marginBottom: "8px",
                            }}
                          >
                            {item.projectId}
                          </span>

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "14px",
                              fontSize: "12px",
                              marginBottom: "4px",
                            }}
                          >
                            <span>Risk Type</span>
                            <strong>{item.riskType}</strong>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "14px",
                              fontSize: "12px",
                            }}
                          >
                            <span>Risk Score</span>
                            <strong>{item.score}/100</strong>
                          </div>

                          <div
                            style={{
                              marginTop: "7px",
                              fontSize: "12px",
                              fontWeight: 700,
                              color: getRiskColor(item.risk),
                            }}
                          >
                            {item.risk} Risk
                          </div>
                        </div>
                      );
                    }}
                  />

                  <Bar
                    dataKey="score"
                    name="Risk Score"
                    radius={[
                      7,
                      7,
                      0,
                      0,
                    ]}
                  >
                    <LabelList
                      dataKey="score"
                      position="top"
                      fill="#172033"
                      fontSize={12}
                      fontWeight={800}
                    />

                    {riskScoreData.map(
                      (
                        entry,
                        index
                      ) => {

                        const score =
                          safeNumber(
                            entry.score
                          );

                        return (
                          <Cell
                            key={`risk-bar-${index}`}
                            fill={
                              score > 60
                                ? "#ef4444"
                                : score > 30
                                ? "#f59e0b"
                                : "#10b981"
                            }
                          />
                        );
                      }
                    )}

                  </Bar>

                </BarChart>

              </ResponsiveContainer>

            </div>

            <div className="chart-note">
              <strong>How to read this chart:</strong>
              <span>
                Each bar represents a project and its risk score.
                Hover over a bar to see the project ID, risk type, score and risk level.
              </span>
            </div>
            </>

          ) : (

            <div className="meaningful-empty">

              <div className="empty-icon">
                ◫
              </div>

              <h3>
                Risk scoring complete
              </h3>

              <p>
                No project-level risk
                scores are available
                in this analysis.
              </p>

            </div>

          )}

        </section>

        {/* =================================================
            PROJECT RISK ANALYSIS
            ================================================= */}

        <section
          id="projects"
          className="panel"
        >

          <div className="panel-header">

            <div>

              <h2>
                Project Risk Analysis
              </h2>

              <p>
                Projects ranked by
                detected anomaly risk.
              </p>

            </div>

            <div className="filter-group">

              {[
                "All",
                "High",
                "Medium",
                "Low",
              ].map(
                (filter) => (

                  <button
                    key={filter}
                    className={
                      riskFilter ===
                      filter
                        ? "filter active"
                        : "filter"
                    }
                    onClick={() =>
                      setRiskFilter(
                        filter
                      )
                    }
                  >
                    {filter}
                  </button>

                )
              )}

            </div>

          </div>

          <div className="table-wrapper">

            <table>

              <thead>

                <tr>

                  <th>
                    Project
                  </th>

                  <th>
                    Location
                  </th>

                  <th>
                    Cost Deviation
                  </th>

                  <th>
                    Utilization
                  </th>

                  <th>
                    Delay
                  </th>

                  <th>
                    Risk Type
                  </th>

                  <th>
                    Risk Score
                  </th>

                  <th>
                    Risk Level
                  </th>

                  <th>
                    Action
                  </th>

                </tr>

              </thead>

              <tbody>

                {filteredProjects.length ===
                0 ? (

                  <tr>

                    <td
                      colSpan="9"
                      className="empty-state"
                    >
                      No projects found
                      for this filter.
                    </td>

                  </tr>

                ) : (

                  filteredProjects.map(
                    (
                      project,
                      index
                    ) => {

                      const risk =
                        getRiskLevel(
                          project
                        );

                      const score =
                        getRiskScore(
                          project
                        );

                      const costDeviation =
                        safeNumber(
                          project.cost_deviation_pct
                        );

                      const utilizationPct =
                        safeNumber(
                          project.fund_utilization_pct ??
                            project.utilization_pct
                        );

                      const delayDays =
                        Math.round(
                          safeNumber(
                            project.delay_days
                          )
                        );

                      return (
                        <tr
                          key={
                            project.project_id ||
                            index
                          }
                        >

                          <td>

                            <div className="project-name">

                              <strong>
                                {project.project_name ||
                                  project.project_id ||
                                  "Unnamed Project"}
                              </strong>

                              <span>
                                {project.project_id ||
                                  "—"}
                              </span>

                            </div>

                          </td>

                          <td>

                            {project.district ||
                              "—"}

                            <br />

                            <small>
                              {project.state ||
                                "—"}
                            </small>

                          </td>

                          <td>

                            <strong
                              className={
                                costDeviation >
                                20
                                  ? "danger-text"
                                  : ""
                              }
                            >
                              {costDeviation.toFixed(
                                1
                              )}
                              %
                            </strong>

                          </td>

                          <td>

                            <strong
                              className={
                                utilizationPct <
                                50
                                  ? "warning-text"
                                  : ""
                              }
                            >
                              {utilizationPct.toFixed(
                                1
                              )}
                              %
                            </strong>

                          </td>

                          <td>

                            {delayDays >
                            0
                              ? `${delayDays} days`
                              : "On time"}

                          </td>

                          <td>

                            <span className="risk-type-pill">
                              {getPrimaryRiskName(project)}
                            </span>

                          </td>

                          <td>

                            <div className="score-cell">

                              <strong>
                                {score}
                              </strong>

                              <div className="mini-score">

                                <span
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      score
                                    )}%`,
                                    background:
                                      getRiskColor(
                                        risk
                                      ),
                                  }}
                                ></span>

                              </div>

                            </div>

                          </td>

                          <td>

                            <span
                              className={`risk-badge ${getRiskClass(
                                risk
                              )}`}
                            >
                              {risk}
                            </span>

                          </td>

                          <td>

                            <button
                              className="view-button"
                              onClick={() =>
                                openProject(
                                  project.project_id
                                )
                              }
                            >
                              View
                            </button>

                          </td>

                        </tr>
                      );
                    }
                  )
                )}

              </tbody>

            </table>

          </div>

        </section>

        {/* =================================================
            ANOMALY SUMMARY
            ================================================= */}

        <section
          id="anomalies"
          className="panel anomaly-summary"
        >

          <div className="panel-header">

            <div>

              <h2>
                Anomaly Detection
                Summary
              </h2>

              <p>
                Explainable rules and
                machine learning are
                combined to prioritize
                unusual patterns.
              </p>

            </div>

          </div>

          <div className="anomaly-cards">

            <div className="anomaly-count high">

              <strong>
                {stats.high_risk}
              </strong>

              <span>
                High-priority cases
              </span>

            </div>

            <div className="anomaly-count medium">

              <strong>
                {stats.medium_risk}
              </strong>

              <span>
                Cases requiring review
              </span>

            </div>

            <div className="anomaly-count low">

              <strong>
                {stats.low_risk}
              </strong>

              <span>
                Low-risk projects
              </span>

            </div>

          </div>

        </section>

        {/* =================================================
            HUMAN VERIFICATION
            ================================================= */}


        {/* ===================================================
            AI INVESTIGATION WORKSPACE
            =================================================== */}

        <section
          id="investigation"
          className="dashboard-section"
        >

          <div className="section-heading">
            <div>
              <span className="section-kicker">
                AI-ASSISTED REVIEW
              </span>

              <h2>
                AI Investigation Workspace
              </h2>

              <p>
                Turn detected anomalies into clear investigation tasks
                for human verification and follow-up.
              </p>
            </div>

            <span className="workspace-status">
              ✦ Investigation Ready
            </span>
          </div>

          {investigationProjects.length > 0 ? (
            <div
              className="investigation-workspace"
            >

              <style>{`
                .investigation-workspace {
                  display: grid;
                  grid-template-columns: 270px minmax(0, 1fr);
                  gap: 16px;
                }

                .investigation-project-list {
                  padding: 14px;
                  border: 1px solid #dbe4f0;
                  border-radius: 16px;
                  background: linear-gradient(135deg, #f7f8ff 0%, #ffffff 100%);
                }

                .investigation-list-title {
                  margin: 2px 4px 11px;
                  color: #172033;
                  font-size: 12px;
                  font-weight: 800;
                  letter-spacing: .6px;
                  text-transform: uppercase;
                }

                .investigation-project-button {
                  width: 100%;
                  display: block;
                  margin: 0 0 8px;
                  padding: 11px 12px;
                  text-align: left;
                  border: 1px solid #e2e8f0;
                  border-radius: 11px;
                  background: #ffffff;
                  cursor: pointer;
                  transition: .18s ease;
                }

                .investigation-project-button:hover {
                  transform: translateY(-1px);
                  border-color: #a5b4fc;
                  box-shadow: 0 5px 16px rgba(99,102,241,.10);
                }

                .investigation-project-button.active {
                  border-color: #6366f1;
                  background: linear-gradient(135deg, #eef2ff 0%, #ffffff 100%);
                  box-shadow: 0 6px 18px rgba(99,102,241,.12);
                }

                .investigation-project-name {
                  display: block;
                  overflow: hidden;
                  color: #172033;
                  font-size: 12px;
                  font-weight: 800;
                  text-overflow: ellipsis;
                  white-space: nowrap;
                }

                .investigation-project-meta {
                  display: flex;
                  justify-content: space-between;
                  gap: 8px;
                  margin-top: 6px;
                  color: #64748b;
                  font-size: 10px;
                }

                .investigation-score {
                  font-weight: 800;
                }

                .investigation-detail {
                  min-width: 0;
                  padding: 20px;
                  border: 1px solid #dbe4f0;
                  border-radius: 16px;
                  background: #ffffff;
                  box-shadow: 0 8px 24px rgba(15,23,42,.05);
                }

                .investigation-detail-head {
                  display: flex;
                  align-items: flex-start;
                  justify-content: space-between;
                  gap: 16px;
                  padding-bottom: 14px;
                  border-bottom: 1px solid #e5e7eb;
                }

                .investigation-detail-head h3 {
                  margin: 0;
                  color: #172033;
                  font-size: 20px;
                  font-weight: 800;
                }

                .investigation-detail-head p {
                  margin: 5px 0 0;
                  color: #64748b;
                  font-size: 11px;
                }

                .investigation-risk-chip {
                  flex-shrink: 0;
                  padding: 7px 11px;
                  border-radius: 999px;
                  font-size: 11px;
                  font-weight: 800;
                }

                .investigation-risk-chip.high {
                  color: #b91c1c;
                  background: #fef2f2;
                  border: 1px solid #fecaca;
                }

                .investigation-risk-chip.medium {
                  color: #b45309;
                  background: #fffbeb;
                  border: 1px solid #fde68a;
                }

                .investigation-risk-chip.low {
                  color: #047857;
                  background: #ecfdf5;
                  border: 1px solid #a7f3d0;
                }

                .investigation-summary {
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 10px;
                  margin: 14px 0;
                }

                .investigation-summary-card {
                  padding: 12px;
                  border-radius: 11px;
                  background: #f8fafc;
                  border: 1px solid #e2e8f0;
                }

                .investigation-summary-card span {
                  display: block;
                  color: #64748b;
                  font-size: 9px;
                  font-weight: 700;
                  text-transform: uppercase;
                }

                .investigation-summary-card strong {
                  display: block;
                  margin-top: 5px;
                  color: #172033;
                  font-size: 17px;
                  font-weight: 800;
                }

                .investigation-tasks-title {
                  margin: 14px 0 10px;
                  color: #172033;
                  font-size: 14px;
                  font-weight: 800;
                }

                .investigation-task {
                  display: flex;
                  align-items: flex-start;
                  gap: 11px;
                  margin-bottom: 9px;
                  padding: 12px;
                  border: 1px solid #e5e7eb;
                  border-radius: 11px;
                  background: #ffffff;
                }

                .investigation-task-icon {
                  flex-shrink: 0;
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  width: 28px;
                  height: 28px;
                  border-radius: 8px;
                  color: #4338ca;
                  background: #eef2ff;
                  font-size: 13px;
                  font-weight: 800;
                }

                .investigation-task strong {
                  display: block;
                  color: #172033;
                  font-size: 12px;
                }

                .investigation-task p {
                  margin: 3px 0 0;
                  color: #64748b;
                  font-size: 11px;
                  line-height: 1.45;
                }

                .investigation-actions {
                  display: flex;
                  flex-wrap: wrap;
                  gap: 9px;
                  margin-top: 14px;
                }

                .investigation-open-button,
                .investigation-verify-button {
                  border: 0;
                  border-radius: 10px;
                  padding: 10px 14px;
                  font-size: 11px;
                  font-weight: 800;
                  cursor: pointer;
                }

                .investigation-open-button {
                  color: #ffffff;
                  background: linear-gradient(135deg, #6366f1, #8b5cf6);
                  box-shadow: 0 7px 18px rgba(99,102,241,.18);
                }

                .investigation-verify-button {
                  color: #9a3412;
                  background: #fff7ed;
                  border: 1px solid #fed7aa;
                }

                .workspace-status {
                  flex-shrink: 0;
                  padding: 8px 12px;
                  color: #4338ca;
                  background: #eef2ff;
                  border: 1px solid #c7d2fe;
                  border-radius: 999px;
                  font-size: 10px;
                  font-weight: 800;
                }

                @media (max-width: 850px) {
                  .investigation-workspace {
                    grid-template-columns: 1fr;
                  }

                  .investigation-summary {
                    grid-template-columns: 1fr;
                  }
                }
              `}</style>

              <div className="investigation-project-list">
                <div className="investigation-list-title">
                  Projects Needing Review
                </div>

                {investigationProjects.map(
                  (project) => {
                    const projectRisk =
                      getRiskLevel(project);

                    return (
                      <button
                        type="button"
                        key={project.project_id}
                        className={`investigation-project-button ${
                          activeInvestigationProject?.project_id ===
                          project.project_id
                            ? "active"
                            : ""
                        }`}
                        onClick={() =>
                          setInvestigationProjectId(
                            project.project_id
                          )
                        }
                      >
                        <span className="investigation-project-name">
                          {project.project_name ||
                            project.project_id}
                        </span>

                        <span className="investigation-project-meta">
                          <span>
                            {project.project_id}
                          </span>

                          <span
                            className="investigation-score"
                            style={{
                              color:
                                getRiskColor(
                                  projectRisk
                                ),
                            }}
                          >
                            {getRiskScore(project)}
                          </span>
                        </span>
                      </button>
                    );
                  }
                )}
              </div>

              {activeInvestigationProject && (
                <div className="investigation-detail">

                  <div className="investigation-detail-head">
                    <div>
                      <h3>
                        {activeInvestigationProject.project_name ||
                          activeInvestigationProject.project_id}
                      </h3>

                      <p>
                        {activeInvestigationProject.project_id}
                        {" "}•{" "}
                        {getPrimaryRiskName(
                          activeInvestigationProject
                        )}
                      </p>
                    </div>

                    <span
                      className={`investigation-risk-chip ${getRiskClass(
                        getRiskLevel(
                          activeInvestigationProject
                        )
                      )}`}
                    >
                      {getRiskLevel(
                        activeInvestigationProject
                      )} Risk •{" "}
                      {getRiskScore(
                        activeInvestigationProject
                      )}
                    </span>
                  </div>

                  <div className="investigation-summary">
                    <div className="investigation-summary-card">
                      <span>Budget Used</span>
                      <strong>
                        {getRiskMetrics(
                          activeInvestigationProject
                        ).budgetUsage.toFixed(1)}
                        %
                      </strong>
                    </div>

                    <div className="investigation-summary-card">
                      <span>Cost Deviation</span>
                      <strong>
                        {getRiskMetrics(
                          activeInvestigationProject
                        ).costDeviation.toFixed(1)}
                        %
                      </strong>
                    </div>

                    <div className="investigation-summary-card">
                      <span>Delay</span>
                      <strong>
                        {getRiskMetrics(
                          activeInvestigationProject
                        ).delayDays}
                        {" "}days
                      </strong>
                    </div>
                  </div>

                  <h4 className="investigation-tasks-title">
                    Investigation Tasks
                  </h4>

                  {investigationTasks.map(
                    (task, index) => (
                      <div
                        className="investigation-task"
                        key={`${task.type}-${index}`}
                      >
                        <div className="investigation-task-icon">
                          ✓
                        </div>

                        <div>
                          <strong>
                            {task.type}
                          </strong>

                          <p>
                            {task.action}
                          </p>
                        </div>
                      </div>
                    )
                  )}

                  <div className="investigation-actions">

                    <button
                      type="button"
                      className="investigation-open-button"
                      onClick={() =>
                        setSelectedProject(
                          activeInvestigationProject
                        )
                      }
                    >
                      Open Project Risk Assessment
                    </button>

                    <button
                      type="button"
                      className="investigation-verify-button"
                      onClick={() =>
                        markForVerification(
                          activeInvestigationProject.project_id
                        )
                      }
                    >
                      ✓ Mark for Verification
                    </button>

                  </div>

                </div>
              )}

            </div>
          ) : (
            <div className="meaningful-empty">
              <strong>
                No projects currently require investigation.
              </strong>
              <span>
                Upload or analyze a dataset with medium or high-risk
                patterns to populate the investigation workspace.
              </span>
            </div>
          )}

        </section>

        <section
          id="verification"
          className="panel verification-panel"
        >

          <div className="panel-header">

            <div>

              <h2>
                Human Verification
                Queue
              </h2>

              <p>
                AI flags suspicious
                patterns; authorized
                officials perform the
                final verification.
              </p>

            </div>

          </div>

          <div className="verification-list">

            {projects
              .filter(
                (project) =>
                  getRiskLevel(
                    project
                  ).toLowerCase() ===
                    "high" ||
                  verificationStatus[
                    project.project_id
                  ]
              )
              .slice(0, 8)
              .map(
                (project) => {

                  const id =
                    project.project_id;

                  return (
                    <div
                      className="verification-row"
                      key={id}
                    >

                      <div>

                        <strong>
                          {project.project_name ||
                            id}
                        </strong>

                        <span>
                          {id} · {getPrimaryRiskName(project)} · Risk Score{" "}
                          {getRiskScore(project)}
                        </span>

                      </div>

                      <div>

                        {verificationStatus[
                          id
                        ] ? (

                          <span className="verification-status">
                            ✓{" "}
                            {
                              verificationStatus[
                                id
                              ]
                            }
                          </span>

                        ) : (

                          <button
                            className="verification-button"
                            onClick={() =>
                              markForVerification(
                                id
                              )
                            }
                          >
                            Mark for Verification
                          </button>

                        )}

                      </div>

                    </div>
                  );
                }
              )}

            {projects.filter(
              (project) =>
                getRiskLevel(
                  project
                ).toLowerCase() ===
                "high"
            ).length === 0 && (

              <div className="empty-verification">

                <strong>
                  No high-risk projects
                  detected
                </strong>

                <p>
                  {stats.total_projects}{" "}
                  projects were analyzed.
                  Projects with unusual
                  patterns will appear
                  here for human
                  verification.
                </p>

              </div>

            )}

          </div>

        </section>

        {/* FOOTER */}

        <footer>

          <p>
            GUARD AI • AI-assisted
            anomaly detection • Human
            verification required for
            final action
          </p>

        </footer>

      </main>

      {/* ===================================================
          PROJECT DETAILS MODAL
          =================================================== */}

      {selectedProject && (

        <div
          className="modal-backdrop"
          onClick={() =>
            setSelectedProject(
              null
            )
          }
        >

          <div
            className="modal"
            onClick={(event) =>
              event.stopPropagation()
            }
          >

            <button
              className="close-button"
              onClick={() =>
                setSelectedProject(
                  null
                )
              }
            >
              ×
            </button>

            <div className="modal-title">

              <span>
                PROJECT RISK ASSESSMENT
              </span>

              <h2>
                {selectedProject.project_name ||
                  selectedProject.project_id}
              </h2>

              <p>
                {
                  selectedProject.project_id
                }
              </p>

            </div>

            <div className="risk-summary">

              <div>

                <span>
                  Risk Score
                </span>

                <strong>
                  {getRiskScore(
                    selectedProject
                  )}
                </strong>

              </div>

              <span
                className={`risk-badge ${getRiskClass(
                  getRiskLevel(
                    selectedProject
                  )
                )}`}
              >
                {getRiskLevel(
                  selectedProject
                )}
              </span>

            </div>

            <div className="detail-grid">

              <div>
                <span className="modal-label">
                  State
                </span>

                <strong>
                  {selectedProject.state ||
                    "—"}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  District
                </span>

                <strong>
                  {selectedProject.district ||
                    "—"}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Constituency
                </span>

                <strong>
                  {selectedProject.constituency ||
                    "—"}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Category
                </span>

                <strong>
                  {selectedProject.category ||
                    "—"}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Vendor
                </span>

                <strong>
                  {selectedProject.vendor ||
                    "—"}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Estimated Cost
                </span>

                <strong>
                  {formatAmount(
                    selectedProject.estimated_cost
                  )}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Actual Expenditure
                </span>

                <strong>
                  {formatAmount(
                    selectedProject.actual_expenditure
                  )}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Amount Released
                </span>

                <strong>
                  {formatAmount(
                    selectedProject.amount_released
                  )}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Amount Utilized
                </span>

                <strong>
                  {formatAmount(
                    selectedProject.amount_utilized
                  )}
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Fund Utilization
                </span>

                <strong>
                  {safeNumber(
                    selectedProject.fund_utilization_pct ??
                      selectedProject.utilization_pct
                  ).toFixed(1)}
                  %
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Delay
                </span>

                <strong>
                  {Math.round(
                    safeNumber(
                      selectedProject.delay_days
                    )
                  )}{" "}
                  days
                </strong>
              </div>

              <div>
                <span className="modal-label">
                  Status
                </span>

                <strong>
                  {selectedProject.status ||
                    "—"}
                </strong>
              </div>

            </div>

            {/* =================================================
                RISK INSIGHTS
                ================================================= */}

            {(() => {
              const metrics = getRiskMetrics(selectedProject);
              const reasons = getRiskReasons(selectedProject);
              const opinion = getRiskOpinion(selectedProject);
              const budgetStatus = getBudgetStatus(selectedProject);

              return (
                <>
                  <style>{`
                    .risk-insights-polished {
                      margin-top: 24px;
                      display: grid;
                      gap: 14px;
                    }

                    .risk-primary-polished {
                      display: flex;
                      align-items: center;
                      justify-content: space-between;
                      gap: 18px;
                      padding: 18px 20px;
                      border: 1px solid #dbe4f0;
                      border-left: 4px solid #6366f1;
                      border-radius: 14px;
                      background: linear-gradient(135deg, #f8faff 0%, #ffffff 100%);
                    }

                    .risk-primary-copy-polished {
                      min-width: 0;
                    }

                    .risk-primary-label-polished {
                      display: block;
                      margin-bottom: 6px;
                      color: #64748b;
                      font-size: 10px;
                      font-weight: 800;
                      letter-spacing: 1.2px;
                    }

                    .risk-primary-title-polished {
                      margin: 0;
                      color: #172033;
                      font-size: 22px;
                      line-height: 1.2;
                      font-weight: 800;
                    }

                    .risk-primary-sub-polished {
                      display: block;
                      margin-top: 6px;
                      color: #64748b;
                      font-size: 12px;
                      line-height: 1.45;
                    }

                    .budget-status-polished {
                      flex-shrink: 0;
                      padding: 8px 12px;
                      border-radius: 999px;
                      font-size: 11px;
                      font-weight: 800;
                      white-space: nowrap;
                    }

                    .budget-status-polished.good {
                      color: #047857;
                      background: #ecfdf5;
                      border: 1px solid #a7f3d0;
                    }

                    .budget-status-polished.warning {
                      color: #b45309;
                      background: #fffbeb;
                      border: 1px solid #fde68a;
                    }

                    .budget-status-polished.danger {
                      color: #b91c1c;
                      background: #fef2f2;
                      border: 1px solid #fecaca;
                    }

                    .budget-status-polished.neutral {
                      color: #475569;
                      background: #f8fafc;
                      border: 1px solid #e2e8f0;
                    }

                    .financial-polished {
                      padding: 18px 20px;
                      border: 1px solid #dbe7e1;
                      border-left: 4px solid #10b981;
                      border-radius: 14px;
                      background: linear-gradient(135deg, #f5fffb 0%, #ffffff 100%);
                    }

                    .polished-section-title {
                      display: flex;
                      align-items: center;
                      gap: 8px;
                      margin: 0 0 14px;
                      color: #172033;
                      font-size: 16px;
                      font-weight: 800;
                    }

                    .polished-section-icon {
                      display: inline-flex;
                      align-items: center;
                      justify-content: center;
                      width: 30px;
                      height: 30px;
                      border-radius: 9px;
                      background: #dcfce7;
                      font-size: 16px;
                    }

                    .financial-grid-polished {
                      display: grid;
                      grid-template-columns: repeat(3, minmax(0, 1fr));
                      gap: 10px;
                    }

                    .financial-card-polished {
                      padding: 12px;
                      text-align: center;
                      border: 1px solid #dfe9e4;
                      border-radius: 11px;
                      background: rgba(255,255,255,.84);
                    }

                    .financial-card-polished span {
                      display: block;
                      color: #64748b;
                      font-size: 10px;
                      font-weight: 700;
                      line-height: 1.3;
                    }

                    .financial-card-polished strong {
                      display: block;
                      margin-top: 5px;
                      color: #172033;
                      font-size: 20px;
                      font-weight: 800;
                    }

                    .financial-card-polished small {
                      display: block;
                      margin-top: 4px;
                      color: #94a3b8;
                      font-size: 9px;
                      line-height: 1.3;
                    }

                    .financial-impact-polished {
                      margin-top: 10px;
                      padding-top: 11px;
                      border-top: 1px solid #dbe7e1;
                      color: #475569;
                      font-size: 12px;
                    }

                    .financial-impact-polished strong {
                      color: #047857;
                    }

                    .risk-cause-polished,
                    .ai-polished,
                    .recommendation-polished {
                      padding: 17px 20px;
                      border-radius: 14px;
                      border: 1px solid #dbe4f0;
                    }

                    .risk-cause-polished {
                      border-left: 4px solid #6366f1;
                      background: linear-gradient(135deg, #f7f8ff 0%, #ffffff 100%);
                    }

                    .ai-polished {
                      border-left: 4px solid #3b82f6;
                      background: linear-gradient(135deg, #f5f9ff 0%, #ffffff 100%);
                    }

                    .recommendation-polished {
                      border-left: 4px solid #f59e0b;
                      background: linear-gradient(135deg, #fffaf0 0%, #ffffff 100%);
                    }

                    .cause-row-polished {
                      display: flex;
                      gap: 11px;
                      align-items: flex-start;
                    }

                    .cause-icon-polished,
                    .ai-icon-polished,
                    .recommendation-icon-polished {
                      flex-shrink: 0;
                      display: inline-flex;
                      align-items: center;
                      justify-content: center;
                      width: 34px;
                      height: 34px;
                      border-radius: 10px;
                      font-size: 17px;
                      font-weight: 800;
                    }

                    .cause-icon-polished {
                      color: #4338ca;
                      background: #e0e7ff;
                    }

                    .ai-icon-polished {
                      background: #dbeafe;
                    }

                    .recommendation-icon-polished {
                      color: #b45309;
                      background: #fef3c7;
                    }

                    .cause-content-polished strong,
                    .ai-content-polished strong {
                      display: block;
                      color: #172033;
                      font-size: 14px;
                      line-height: 1.35;
                    }

                    .cause-content-polished p,
                    .ai-content-polished p {
                      margin: 4px 0 0;
                      color: #64748b;
                      font-size: 12px;
                      line-height: 1.5;
                    }

                    .ai-label-polished {
                      display: block;
                      margin-bottom: 4px;
                      color: #2563eb;
                      font-size: 10px;
                      font-weight: 800;
                      letter-spacing: 1px;
                    }

                    .recommendation-list-polished {
                      margin: 0;
                      padding-left: 20px;
                      color: #475569;
                      font-size: 12px;
                      line-height: 1.55;
                    }

                    .recommendation-list-polished li + li {
                      margin-top: 7px;
                    }

                    @media (max-width: 700px) {
                      .financial-grid-polished {
                        grid-template-columns: 1fr;
                      }

                      .risk-primary-polished {
                        align-items: flex-start;
                        flex-direction: column;
                      }
                    }
                  `}</style>

                  <div className="risk-insights-polished">

                    <div className="risk-primary-polished">
                      <div className="risk-primary-copy-polished">
                        <span className="risk-primary-label-polished">
                          PRIMARY RISK TYPE
                        </span>

                        <h3 className="risk-primary-title-polished">
                          {getPrimaryRiskName(selectedProject)}
                        </h3>

                        <span className="risk-primary-sub-polished">
                          {getRiskLevel(selectedProject).toLowerCase() === "low"
                            ? "No significant anomaly detected in this project."
                            : "Main anomaly pattern identified from the available project data."}
                        </span>
                      </div>

                      <span
                        className={`budget-status-polished ${budgetStatus.className}`}
                      >
                        {budgetStatus.label}
                      </span>
                    </div>

                    <div className="financial-polished">
                      <h3 className="polished-section-title">
                        <span className="polished-section-icon">💰</span>
                        Financial Overview
                      </h3>

                      <div className="financial-grid-polished">
                        <div className="financial-card-polished">
                          <span>Budget Used</span>
                          <strong>{metrics.budgetUsage.toFixed(1)}%</strong>
                          <small>Actual vs estimated</small>
                        </div>

                        <div className="financial-card-polished">
                          <span>Cost Deviation</span>
                          <strong
                            className={
                              metrics.costDeviation > 20
                                ? "danger-text"
                                : ""
                            }
                          >
                            {metrics.costDeviation.toFixed(1)}%
                          </strong>
                          <small>Difference from estimate</small>
                        </div>

                        <div className="financial-card-polished">
                          <span>Released Funds Used</span>
                          <strong>
                            {metrics.releaseUtilization.toFixed(1)}%
                          </strong>
                          <small>Utilized vs released</small>
                        </div>
                      </div>

                      <div className="financial-impact-polished">
                        Financial Impact:{" "}
                        <strong>
                          {formatAmount(
                            Math.max(
                              0,
                              metrics.actualExpenditure -
                                metrics.estimatedCost
                            )
                          )}
                        </strong>
                        {" "}• Expenditure above estimate
                      </div>
                    </div>

                    <div className="risk-cause-polished">
                      <h3 className="polished-section-title">
                        <span className="polished-section-icon">🔎</span>
                        What is causing the risk?
                      </h3>

                      {reasons.map((reason, index) => (
                        <div
                          className="cause-row-polished"
                          key={`${reason.type}-${index}`}
                        >
                          <div className="cause-icon-polished">
                            {reason.severity === "high"
                              ? "!"
                              : reason.severity === "medium"
                              ? "•"
                              : "✓"}
                          </div>

                          <div className="cause-content-polished">
                            <strong>{reason.type}</strong>
                            <p>{reason.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="ai-polished">
                      <div className="cause-row-polished">
                        <div className="ai-icon-polished">
                          {opinion.icon}
                        </div>

                        <div className="ai-content-polished">
                          <span className="ai-label-polished">
                            AI ASSESSMENT
                          </span>

                          <strong>{opinion.label}</strong>

                          <p>{opinion.text}</p>
                        </div>
                      </div>
                    </div>

                    <div className="recommendation-polished">
                      <h3 className="polished-section-title">
                        <span className="recommendation-icon-polished">
                          🛠
                        </span>
                        Recommended Actions
                      </h3>

                      <ul className="recommendation-list-polished">
                        {reasons.map((reason, index) => (
                          <li key={`action-${reason.type}-${index}`}>
                            {reason.action}
                          </li>
                        ))}
                      </ul>
                    </div>

                  </div>
                </>
              );
            })()}

            <div
              className="explanation"
              style={{
                marginTop: "16px",
                borderLeft: "4px solid #8b5cf6",
                background:
                  "linear-gradient(135deg, #f7f5ff 0%, #ffffff 100%)",
              }}
            >

              <h3>
                Why was this project
                flagged?
              </h3>

              {Array.isArray(
                selectedProject.explanations
              ) &&
              selectedProject.explanations
                .length > 0 ? (

                <ul>

                  {selectedProject.explanations.map(
                    (
                      explanation,
                      index
                    ) => (
                      <li
                        key={index}
                      >
                        {
                          explanation
                        }
                      </li>
                    )
                  )}

                </ul>

              ) : (

                <p>
                  No specific
                  rule-based explanation
                  was returned for this
                  project.
                </p>

              )}

            </div>

            <div className="modal-actions">

              <button
                className="verification-button"
                onClick={() => {

                  markForVerification(
                    selectedProject.project_id
                  );

                  setSelectedProject(
                    null
                  );

                  scrollToSection(
                    "verification"
                  );
                }}
              >
                ✓ Mark for Verification
              </button>

              <button
                className="secondary-button"
                onClick={() =>
                  setSelectedProject(
                    null
                  )
                }
              >
                Close
              </button>

            </div>

          </div>

        </div>

      )}

    </div>
  );
}

export default App;