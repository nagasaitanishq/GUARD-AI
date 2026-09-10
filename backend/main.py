from io import BytesIO
from pathlib import Path

import pandas as pd
import pdfplumber

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.anomaly_engine import (
    get_project_results,
)

app = FastAPI(
    title="MPLAD AI Anomaly Detection API"
)

# ---------------------------------------------------------
# CORS
# ---------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# PATHS
# ---------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent

DATASET_PATH = (
    BASE_DIR
    / "dataset"
    / "active_mplad_projects.csv"
)

# ---------------------------------------------------------
# REQUIRED COLUMNS
# ---------------------------------------------------------

REQUIRED_COLUMNS = [
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
]

NUMERIC_COLUMNS = [
    "sanctioned_amount",
    "estimated_cost",
    "actual_expenditure",
    "amount_released",
    "amount_utilized",
]


# ---------------------------------------------------------
# BASIC ROUTES
# ---------------------------------------------------------

@app.get("/")
def root():
    return {
        "message": "MPLAD AI Anomaly Detection API",
        "status": "running",
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }


# ---------------------------------------------------------
# READ PDF
# ---------------------------------------------------------

def read_pdf_file(contents: bytes) -> pd.DataFrame:

    tables = []

    try:
        with pdfplumber.open(
            BytesIO(contents)
        ) as pdf:

            for page in pdf.pages:

                page_tables = page.extract_tables()

                for table in page_tables:

                    if not table or len(table) < 2:
                        continue

                    # First row treated as header
                    header = table[0]

                    rows = table[1:]

                    if not header:
                        continue

                    cleaned_header = []

                    for column in header:
                        if column is None:
                            cleaned_header.append("")
                        else:
                            cleaned_header.append(
                                str(column).strip()
                            )

                    df = pd.DataFrame(
                        rows,
                        columns=cleaned_header,
                    )

                    tables.append(df)

    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=f"Unable to read PDF: {error}",
        )

    if not tables:
        raise HTTPException(
            status_code=400,
            detail=(
                "No readable table was found in the PDF. "
                "Please upload a PDF containing MPLAD project data in table format."
            ),
        )

    combined = pd.concat(
        tables,
        ignore_index=True,
    )

    # Clean column names
    combined.columns = [
        str(column).strip().lower().replace(" ", "_")
        for column in combined.columns
    ]

    return combined


# ---------------------------------------------------------
# VALIDATE DATA
# ---------------------------------------------------------

def validate_dataset(df: pd.DataFrame):

    df.columns = [
        str(column).strip()
        for column in df.columns
    ]

    # Case-insensitive column matching
    column_map = {
        str(column).strip().lower().replace(" ", "_"): column
        for column in df.columns
    }

    missing_columns = []

    for required in REQUIRED_COLUMNS:

        if required not in column_map:
            missing_columns.append(required)

    if missing_columns:

        raise HTTPException(
            status_code=400,
            detail={
                "message": "Required MPLAD columns are missing.",
                "missing_columns": missing_columns,
            },
        )

    # Rename columns to standard names
    rename_map = {
        column_map[required]: required
        for required in REQUIRED_COLUMNS
    }

    df = df.rename(
        columns=rename_map
    )

    return df


# ---------------------------------------------------------
# CLEAN DATA
# ---------------------------------------------------------

def clean_dataset(df: pd.DataFrame):

    # Numeric fields
    for column in NUMERIC_COLUMNS:

        df[column] = pd.to_numeric(
            df[column],
            errors="coerce",
        )

    # Replace invalid numeric values
    df[NUMERIC_COLUMNS] = (
        df[NUMERIC_COLUMNS]
        .fillna(0)
    )

    # Text fields
    text_columns = [
        "project_id",
        "project_name",
        "state",
        "district",
        "constituency",
        "category",
        "vendor",
        "status",
    ]

    for column in text_columns:

        df[column] = (
            df[column]
            .fillna("")
            .astype(str)
            .str.strip()
        )

    # Date fields
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

    return df


# ---------------------------------------------------------
# UPLOAD
# ---------------------------------------------------------

@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...)
):

    filename = (
        file.filename or ""
    ).lower()

    allowed_extensions = (
        ".csv",
        ".xlsx",
        ".pdf",
    )

    if not filename.endswith(
        allowed_extensions
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file type. "
                "Please upload CSV, Excel (.xlsx), or PDF."
            ),
        )

    contents = await file.read()

    if not contents:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty.",
        )

    # -----------------------------------------------------
    # READ FILE
    # -----------------------------------------------------

    try:

        if filename.endswith(".csv"):

            df = pd.read_csv(
                BytesIO(contents)
            )

        elif filename.endswith(".xlsx"):

            df = pd.read_excel(
                BytesIO(contents)
            )

        elif filename.endswith(".pdf"):

            df = read_pdf_file(
                contents
            )

        else:

            raise HTTPException(
                status_code=400,
                detail="Unsupported file type.",
            )

    except HTTPException:
        raise

    except Exception as error:

        raise HTTPException(
            status_code=400,
            detail=f"Unable to read uploaded file: {error}",
        )

    # -----------------------------------------------------
    # VALIDATE
    # -----------------------------------------------------

    df = validate_dataset(df)

    # -----------------------------------------------------
    # CLEAN
    # -----------------------------------------------------

    df = clean_dataset(df)

    if len(df) == 0:

        raise HTTPException(
            status_code=400,
            detail="The uploaded file contains no project records.",
        )

    # -----------------------------------------------------
    # SAVE AS ACTIVE DATASET
    # -----------------------------------------------------

    DATASET_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Save normalized data as CSV.
    # The AI engine reads this active CSV.
    df.to_csv(
        DATASET_PATH,
        index=False,
    )

    # -----------------------------------------------------
    # RUN AI ANALYSIS
    # -----------------------------------------------------

    results = get_project_results()

    if not results:

        raise HTTPException(
            status_code=500,
            detail="Data uploaded but AI analysis returned no results.",
        )

    high_risk = sum(
        1
        for project in results
        if project["risk_level"] == "High"
    )

    medium_risk = sum(
        1
        for project in results
        if project["risk_level"] == "Medium"
    )

    low_risk = sum(
        1
        for project in results
        if project["risk_level"] == "Low"
    )

    return {
        "message": "File uploaded and analyzed successfully.",
        "filename": file.filename,
        "total_projects": len(results),
        "high_risk_projects": high_risk,
        "medium_risk_projects": medium_risk,
        "low_risk_projects": low_risk,
    }


# ---------------------------------------------------------
# PROJECTS
# ---------------------------------------------------------

@app.get("/projects")
def projects():

    results = get_project_results()

    return {
        "projects": results,
        "total": len(results),
    }


# ---------------------------------------------------------
# ANOMALIES
# ---------------------------------------------------------

@app.get("/anomalies")
def anomalies():

    results = get_project_results()

    flagged = [
        project
        for project in results
        if project["risk_level"]
        in ["High", "Medium"]
    ]

    return {
        "anomalies": flagged,
        "total": len(flagged),
    }


# ---------------------------------------------------------
# DASHBOARD STATS
# ---------------------------------------------------------

@app.get("/dashboard/stats")
def dashboard_stats():

    results = get_project_results()

    if not results:

        return {
            "total_projects": 0,
            "high_risk_projects": 0,
            "medium_risk_projects": 0,
            "low_risk_projects": 0,
            "total_sanctioned_amount": 0,
            "total_utilized_amount": 0,
        }

    high_risk = sum(
        1
        for project in results
        if project["risk_level"] == "High"
    )

    medium_risk = sum(
        1
        for project in results
        if project["risk_level"] == "Medium"
    )

    low_risk = sum(
        1
        for project in results
        if project["risk_level"] == "Low"
    )

    total_sanctioned = sum(
        project["sanctioned_amount"]
        for project in results
    )

    total_utilized = sum(
        project["amount_utilized"]
        for project in results
    )

    return {
        "total_projects": len(results),
        "high_risk_projects": high_risk,
        "medium_risk_projects": medium_risk,
        "low_risk_projects": low_risk,
        "total_sanctioned_amount": total_sanctioned,
        "total_utilized_amount": total_utilized,
    }


# ---------------------------------------------------------
# SINGLE PROJECT
# ---------------------------------------------------------

@app.get("/projects/{project_id}")
def get_project(
    project_id: str
):

    results = get_project_results()

    for project in results:

        if project["project_id"] == project_id:

            return project

    raise HTTPException(
        status_code=404,
        detail="Project not found.",
    )