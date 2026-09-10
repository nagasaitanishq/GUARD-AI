from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest


BASE_DIR = Path(__file__).resolve().parent.parent

# This is the dataset actually used by the application.
# It will only exist after the user uploads a CSV.
ACTIVE_DATASET_PATH = (
    BASE_DIR / "dataset" / "active_mplad_projects.csv"
)


def load_projects():
    """Load and prepare the currently uploaded MPLAD project data."""

    # No uploaded dataset yet
    if not ACTIVE_DATASET_PATH.exists():
        return pd.DataFrame()

    df = pd.read_csv(ACTIVE_DATASET_PATH)

    if df.empty:
        return df

    date_columns = [
        "start_date",
        "expected_completion_date",
        "actual_completion_date",
    ]

    for column in date_columns:
        df[column] = pd.to_datetime(
            df[column],
            errors="coerce",
        )

    # ---------------------------------------------------------
    # Financial features
    # ---------------------------------------------------------

    df["cost_deviation_pct"] = (
        (
            df["actual_expenditure"]
            - df["estimated_cost"]
        )
        / df["estimated_cost"]
        * 100
    )

    df["fund_utilization_pct"] = (
        df["amount_utilized"]
        / df["amount_released"]
        * 100
    ).replace(
        [np.inf, -np.inf],
        np.nan,
    ).fillna(0)

    df["release_utilization_gap"] = (
        df["amount_released"]
        - df["amount_utilized"]
    )

    # ---------------------------------------------------------
    # Project delay
    # ---------------------------------------------------------

    df["delay_days"] = (
        df["actual_completion_date"]
        - df["expected_completion_date"]
    ).dt.days

    df["delay_days"] = (
        df["delay_days"]
        .fillna(0)
        .clip(lower=0)
    )

    # ---------------------------------------------------------
    # Project duration
    # ---------------------------------------------------------

    df["project_duration_days"] = (
        df["actual_completion_date"]
        - df["start_date"]
    ).dt.days

    df["project_duration_days"] = (
        df["project_duration_days"]
        .fillna(
            (
                df["expected_completion_date"]
                - df["start_date"]
            ).dt.days
        )
        .fillna(0)
        .clip(lower=0)
    )

    return df


def add_rule_based_anomalies(df):
    """Apply transparent business rules to identify suspicious patterns."""

    if df.empty:
        return df

    # ---------------------------------------------------------
    # Cost anomaly
    # ---------------------------------------------------------

    df["cost_anomaly"] = (
        df["cost_deviation_pct"] > 20
    )

    # ---------------------------------------------------------
    # Delay anomaly
    # ---------------------------------------------------------

    df["delay_anomaly"] = (
        df["delay_days"] > 60
    )

    # ---------------------------------------------------------
    # Fund utilization anomaly
    # ---------------------------------------------------------

    df["utilization_anomaly"] = (
        (df["amount_released"] > 0)
        & (df["fund_utilization_pct"] < 50)
    )

    # ---------------------------------------------------------
    # Duplicate project ID
    # ---------------------------------------------------------

    df["duplicate_anomaly"] = df.duplicated(
        subset=["project_id"],
        keep=False,
    )

    # ---------------------------------------------------------
    # Vendor pattern
    # ---------------------------------------------------------

    vendor_counts = df["vendor"].value_counts()

    df["vendor_project_count"] = (
        df["vendor"].map(vendor_counts)
    )

    vendor_threshold = max(
        4,
        int(len(df) * 0.20),
    )

    df["vendor_pattern_anomaly"] = (
        df["vendor_project_count"]
        >= vendor_threshold
    )

    return df


def add_ml_anomalies(df):
    """Use Isolation Forest to identify unusual numerical patterns."""

    if df.empty:
        return df

    features = [
        "sanctioned_amount",
        "estimated_cost",
        "actual_expenditure",
        "amount_released",
        "amount_utilized",
        "cost_deviation_pct",
        "fund_utilization_pct",
        "delay_days",
        "project_duration_days",
    ]

    X = df[features].replace(
        [np.inf, -np.inf],
        np.nan,
    ).fillna(0)

    # ---------------------------------------------------------
    # Very small datasets
    # ---------------------------------------------------------

    # Isolation Forest is not useful with only one project.
    if len(df) < 2:
        df["ml_anomaly"] = False
        df["ml_score"] = 0.0
        return df

    # ---------------------------------------------------------
    # Isolation Forest
    # ---------------------------------------------------------

    model = IsolationForest(
        n_estimators=200,
        contamination=min(
            0.25,
            max(0.05, 2 / len(df)),
        ),
        random_state=42,
    )

    predictions = model.fit_predict(X)

    raw_scores = model.decision_function(X)

    df["ml_anomaly"] = (
        predictions == -1
    )

    # ---------------------------------------------------------
    # Convert ML score to 0-100
    # ---------------------------------------------------------

    min_score = raw_scores.min()
    max_score = raw_scores.max()

    if max_score == min_score:
        df["ml_score"] = 0
    else:
        df["ml_score"] = (
            (max_score - raw_scores)
            / (max_score - min_score)
            * 100
        )

    return df


def calculate_risk_score(df):
    """Combine ML and rule-based signals into a transparent risk score."""

    if df.empty:
        return df

    rule_score = (
        df["cost_anomaly"].astype(int) * 25
        + df["delay_anomaly"].astype(int) * 20
        + df["utilization_anomaly"].astype(int) * 20
        + df["duplicate_anomaly"].astype(int) * 15
        + df["vendor_pattern_anomaly"].astype(int) * 10
    )

    # ML contributes up to 30 points.
    ml_contribution = (
        df["ml_score"] * 0.30
    )

    df["risk_score"] = (
        rule_score + ml_contribution
    ).clip(
        0,
        100,
    ).round(
        0
    ).astype(int)

    df["risk_level"] = pd.cut(
        df["risk_score"],
        bins=[
            -1,
            30,
            60,
            100,
        ],
        labels=[
            "Low",
            "Medium",
            "High",
        ],
    ).astype(str)

    return df


def generate_explanations(row):
    """Generate human-readable reasons for an anomaly."""

    reasons = []

    if row["cost_anomaly"]:
        reasons.append(
            f"Actual expenditure is "
            f"{row['cost_deviation_pct']:.1f}% "
            "above the estimated cost."
        )

    if row["delay_anomaly"]:
        reasons.append(
            f"Project is delayed by "
            f"{int(row['delay_days'])} days."
        )

    if row["utilization_anomaly"]:
        reasons.append(
            f"Only "
            f"{row['fund_utilization_pct']:.1f}% "
            "of released funds have been utilized."
        )

    if row["duplicate_anomaly"]:
        reasons.append(
            "Duplicate project identifier detected."
        )

    if row["vendor_pattern_anomaly"]:
        reasons.append(
            f"Vendor is associated with "
            f"{int(row['vendor_project_count'])} "
            "projects in the dataset."
        )

    if row["ml_anomaly"]:
        reasons.append(
            "Machine-learning model identified "
            "an unusual combination of project "
            "characteristics."
        )

    if not reasons:
        reasons.append(
            "No significant anomaly detected."
        )

    return reasons


def analyze_projects():
    """Run the complete MPLAD anomaly detection pipeline."""

    df = load_projects()

    # No user data uploaded yet
    if df.empty:
        return df

    df = add_rule_based_anomalies(df)

    df = add_ml_anomalies(df)

    df = calculate_risk_score(df)

    df["explanations"] = df.apply(
        generate_explanations,
        axis=1,
    )

    return df


def get_project_results():
    """Return analyzed projects in JSON-friendly format."""

    df = analyze_projects()

    # No uploaded data
    if df.empty:
        return []

    date_columns = [
        "start_date",
        "expected_completion_date",
        "actual_completion_date",
    ]

    for column in date_columns:
        df[column] = df[column].dt.strftime(
            "%Y-%m-%d"
        )

    result_columns = [
        "project_id",
        "project_name",
        "state",
        "district",
        "constituency",
        "category",
        "sanctioned_amount",
        "estimated_cost",
        "actual_expenditure",
        "amount_released",
        "amount_utilized",
        "start_date",
        "expected_completion_date",
        "actual_completion_date",
        "vendor",
        "status",
        "cost_deviation_pct",
        "fund_utilization_pct",
        "delay_days",
        "ml_anomaly",
        "ml_score",
        "risk_score",
        "risk_level",
        "explanations",
    ]

    return (
        df[result_columns]
        .replace({np.nan: None})
        .to_dict(orient="records")
    )