# One outcome rule shared by commit/counter recovery and read-only receipt proof.
def mbot_execution_fault($events):
  def cancellation_error: .=="ABORTED" or .=="ABORTED_BEFORE_DISPATCH" or .=="APPROVAL_CANCELLED";
  any($events[];
    ((.type=="assistant/message" or .type=="assistant/attempt") and any(.data.stream[]?;
      .chunk.type=="finish" and (.chunk.reason.kind=="max-tokens"
        or (.chunk.reason.kind=="error" and (.chunk.reason.failure.code | cancellation_error | not)))))
    or (.type=="tool/result" and .data.message.isError==true and (.data.error.code | cancellation_error | not)));

def mbot_outcome($journalVersion):
  if (.success|type)!="boolean" then error("invalid success")
  elif ($journalVersion==2 or $journalVersion==3 or $journalVersion==4) and .runtime.outcome_schema_version!=1 then error("versioned journal requires versioned outcome")
  elif (has("outcome") or has("failure_count_effect") or .runtime.outcome_schema_version!=null) then
    if .runtime.outcome_schema_version!=1 or (.runtime.execution_fault|type)!="boolean" or (.violations|type)!="array" then error("invalid outcome version")
    elif .outcome=="completed" and .success==true and .failure_count_effect=="reset" and (.violations|length)==0 then .outcome
    elif .outcome=="cancelled" and .success==false and .failure_count_effect=="preserve"
      and ($journalVersion==2 or $journalVersion==3 or $journalVersion==4) and .reason.kind=="aborted" and .reason.reason.kind=="user" and (.violations|length)==0 and .runtime.execution_fault==false then .outcome
    elif .outcome=="failed" and .success==false and .failure_count_effect=="increment" then .outcome
    else error("invalid outcome effect") end
  elif .success then "completed" else "failed" end;
