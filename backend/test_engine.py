from anomaly_engine import analyze_projects


def main():
    df = analyze_projects()

    print("\n" + "=" * 70)
    print("MPLAD AI ANOMALY DETECTION RESULTS")
    print("=" * 70)

    for _, row in df.sort_values("risk_score", ascending=False).iterrows():
        print(f"\nProject: {row['project_id']} - {row['project_name']}")
        print(f"Risk Score: {row['risk_score']}/100")
        print(f"Risk Level: {row['risk_level']}")
        print(f"Cost Deviation: {row['cost_deviation_pct']:.1f}%")
        print(f"Fund Utilization: {row['fund_utilization_pct']:.1f}%")
        print(f"Delay: {int(row['delay_days'])} days")

        print("Reasons:")
        for reason in row["explanations"]:
            print(f"  - {reason}")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    main()