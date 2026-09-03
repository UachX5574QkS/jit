SET DEFINE OFF

-- MCR Workflows ORDS Module - graph and states endpoints
-- The base module (mcr_workflows) and its root handler already exist.
-- This script adds the states and graph templates.

BEGIN
  -- States endpoint: returns all states for a workflow
  ORDS.DEFINE_TEMPLATE(
    p_module_name => 'mcr_workflows',
    p_pattern     => 'states/:workflow_id'
  );

  ORDS.DEFINE_HANDLER(
    p_module_name  => 'mcr_workflows',
    p_pattern      => 'states/:workflow_id',
    p_method       => 'GET',
    p_source_type  => 'json/collection',
    p_source       => q'[
      SELECT state_id, workflow_id, state_name, state_type, sort_order, color_code, description
        FROM tab_mcr_workflow_states
       WHERE workflow_id = :workflow_id
       ORDER BY sort_order
    ]'
  );

  -- Graph endpoint: returns nodes + edges JSON for Cytoscape rendering
  ORDS.DEFINE_TEMPLATE(
    p_module_name => 'mcr_workflows',
    p_pattern     => 'graph/:workflow_id'
  );

  ORDS.DEFINE_HANDLER(
    p_module_name  => 'mcr_workflows',
    p_pattern      => 'graph/:workflow_id',
    p_method       => 'GET',
    p_source_type  => 'plsql/block',
    p_source       => q'[
DECLARE
  l_workflow_id NUMBER := :workflow_id;
BEGIN
  APEX_JSON.OPEN_OBJECT;

  -- nodes array
  APEX_JSON.OPEN_ARRAY('nodes');
  FOR r IN (
    SELECT state_id, state_name, state_type, color_code
      FROM tab_mcr_workflow_states
     WHERE workflow_id = l_workflow_id
     ORDER BY sort_order
  ) LOOP
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('id', 's-' || r.state_id);
    APEX_JSON.WRITE('label', r.state_name);
    APEX_JSON.WRITE('state_type', r.state_type);
    APEX_JSON.WRITE('color', r.color_code);
    APEX_JSON.CLOSE_OBJECT;
  END LOOP;
  APEX_JSON.CLOSE_ARRAY;

  -- edges array
  APEX_JSON.OPEN_ARRAY('edges');
  FOR r IN (
    SELECT transition_id, from_state_id, to_state_id, trigger_type, transition_label
      FROM tab_mcr_workflow_transitions
     WHERE workflow_id = l_workflow_id
     ORDER BY from_state_id, sort_order
  ) LOOP
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('source', 's-' || r.from_state_id);
    APEX_JSON.WRITE('target', 's-' || r.to_state_id);
    APEX_JSON.WRITE('label', r.transition_label);
    APEX_JSON.WRITE('trigger_type', r.trigger_type);
    APEX_JSON.CLOSE_OBJECT;
  END LOOP;
  APEX_JSON.CLOSE_ARRAY;

  APEX_JSON.CLOSE_OBJECT;
END;
    ]'
  );

  COMMIT;
END;
/
